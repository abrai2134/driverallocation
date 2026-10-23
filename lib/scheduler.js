// Fair driver allocation.
//
// Each working day every active unit gets one slot per entry in `unit.slots`. A slot has a
// 1st-choice vehicle type (2W/3W/4W or any) and a 2nd choice used when no 1st-choice
// driver is free: another type, "any other vehicle", or "none" (leave it empty rather
// than send a different vehicle). Slot 1 is the unit's most important driver, slot 2 the
// next, and so on; important slots get their right vehicle before less important ones.
//
// Drivers are matched to slots with the Hungarian algorithm (optimal assignment) using a
// cost that, in order of importance:
//   1. fills as many slots as possible, dropping only the least important slots when
//      there are not enough drivers (and rotating that shortage between units),
//   2. gives each slot its 1st-choice vehicle, else its 2nd choice (important slots first),
//   3. gives the day's duties to the drivers with the fewest duties so far (equal duty),
//   4. sends each driver to the units they have served least (rotation across units),
//   5. avoids the same unit two working days in a row,
//   6. prefers the driver who has rested longest.
// Drivers on leave, inactive drivers and drivers that break a strict vehicle rule are
// never assigned.

const { addDays, diffDays, dayOfWeek } = require('./dates');

// Vehicle-choice costs, multiplied by slot importance (slot 1 x4, slot 2 x3, slot 3 x2, rest x1).
const W_SECOND_CHOICE = 1.5e6;
const W_OTHER_VEHICLE = 4e6;
const W_DUTY = 1e6;
const W_PAIR = 1e3;
const W_REPEAT = 500;
const W_REST = 1; // subtracted per rest day (capped)
const COST_UNFILLED = 1e9;
const W_UNFILLED_PRIORITY = 1e8; // per slot position: earlier slots are kept first
const W_UNFILLED_HISTORY = 1e6;
const MAX_SLOTS = 10;
const VEHICLES = ['4W', '3W', '2W'];
const COST_FORBIDDEN = 1e13;

// ---------- helpers ----------

function isWorkingDay(db, date) {
  const s = db.settings;
  if ((s.offDays || []).includes(dayOfWeek(date))) return false;
  if ((s.holidays || []).includes(date)) return false;
  return true;
}

function onLeave(db, driverId, date) {
  return db.leaves.some((l) => l.driverId === driverId && l.from <= date && date <= l.to);
}

function activeUnits(db) {
  return db.units
    .filter((u) => u.active && !u.deleted)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function availableDrivers(db, date) {
  return db.drivers
    .filter((d) => d.active && !d.deleted && !onLeave(db, d.id, date))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Normalise one slot. `second` is a vehicle type, 'ANY' (any other vehicle) or 'NONE'
// (1st choice only). Older data used `strict: true` for 'NONE'.
function normSlot(s) {
  const type = VEHICLES.includes(s && s.type) ? s.type : 'ANY';
  if (type === 'ANY') return { type, second: 'ANY' };
  let second = s && s.second;
  if (!(VEHICLES.includes(second) || second === 'ANY' || second === 'NONE')) second = s && s.strict ? 'NONE' : 'ANY';
  if (second === type) second = 'NONE';
  return { type, second };
}

// The slot list of a unit; older data only had `driversNeeded`.
function unitSlots(unit) {
  if (Array.isArray(unit.slots) && unit.slots.length) return unit.slots.slice(0, MAX_SLOTS).map(normSlot);
  const n = Math.max(1, Math.min(MAX_SLOTS, Number(unit.driversNeeded) || 1));
  return Array.from({ length: n }, () => ({ type: 'ANY', second: 'ANY' }));
}

// 0 = 1st choice, 1 = 2nd choice, 2 = some other vehicle, -1 = not allowed.
function vehicleFit(spec, vehicleType) {
  if (spec.type === 'ANY' || spec.type === vehicleType) return 0;
  if (spec.second === vehicleType) return 1;
  if (spec.second === 'ANY') return 2;
  return -1;
}

function canServe(driver, unit, slot) {
  const types = unit.vehicleTypes || [];
  if (types.length && !types.includes(driver.vehicleType)) return false;
  if (slot !== undefined && slot !== null) {
    const spec = unitSlots(unit)[slot];
    if (spec && vehicleFit(spec, driver.vehicleType) < 0) return false;
  }
  return true;
}

// History of everything strictly before `date`.
function historyBefore(db, date) {
  const duty = {};
  const pair = {};
  const last = {};
  const unfilled = {};
  let prevDay = null;
  for (const a of db.assignments) {
    if (a.date >= date) continue;
    if (a.driverId) {
      duty[a.driverId] = (duty[a.driverId] || 0) + 1;
      const k = a.driverId + '|' + a.unitId;
      pair[k] = (pair[k] || 0) + 1;
      if (!last[a.driverId] || last[a.driverId] < a.date) last[a.driverId] = a.date;
    } else {
      unfilled[a.unitId] = (unfilled[a.unitId] || 0) + 1;
    }
    if (!prevDay || a.date > prevDay) prevDay = a.date;
  }
  const prevUnit = {};
  if (prevDay) {
    for (const a of db.assignments) {
      if (a.date === prevDay && a.driverId) prevUnit[a.driverId] = a.unitId;
    }
  }
  return { duty, pair, last, unfilled, prevUnit };
}

function effectiveDuty(db, driver, hist) {
  return (driver.baseline || 0) + (hist.duty[driver.id] || 0);
}

// When a driver joins (or comes back), start them level with the least-used active
// driver so they are not flooded with duties to "catch up".
function alignBaseline(db, driver, date) {
  const hist = historyBefore(db, date);
  const others = db.drivers.filter((d) => d.id !== driver.id && d.active && !d.deleted);
  const minOther = others.length ? Math.min(...others.map((d) => effectiveDuty(db, d, hist))) : 0;
  const own = hist.duty[driver.id] || 0;
  driver.baseline = Math.max(driver.baseline || 0, minOther - own);
}

// Standard O(n^2 m) Hungarian algorithm for n rows <= m columns. Returns col index per row.
function hungarian(cost) {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0].length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

function vehicleCost(slot, driver) {
  const fit = vehicleFit(slot.spec, driver.vehicleType);
  const weight = 4 - Math.min(slot.slot, 3);
  return fit === 1 ? W_SECOND_CHOICE * weight : fit === 2 ? W_OTHER_VEHICLE * weight : 0;
}

// ---------- planning ----------

// Plan one day. `pinned` assignments are kept as-is (if still valid); the rest is filled.
// Emergency extra drivers (requested by a unit) use slot numbers from EXTRA_SLOT up, are
// kept whenever the day is re-planned, and reserve their driver for that unit.
const EXTRA_SLOT = 100;

function planDay(db, date, pinned = []) {
  const extras = db.assignments.filter((a) => a.date === date && a.extra && a.driverId);
  db.assignments = db.assignments.filter((a) => a.date !== date);
  db.generated[date] = true;

  const units = activeUnits(db);
  const drivers = availableDrivers(db, date);
  const unitById = Object.fromEntries(units.map((u) => [u.id, u]));
  const driverById = Object.fromEntries(drivers.map((d) => [d.id, d]));

  const result = [];
  const usedDrivers = new Set();
  for (const e of extras) {
    if (!unitById[e.unitId] || !driverById[e.driverId] || usedDrivers.has(e.driverId)) continue;
    usedDrivers.add(e.driverId);
    result.push({ ...e });
  }
  if (!isWorkingDay(db, date)) {
    db.assignments.push(...result);
    return result;
  }

  const slots = [];
  for (const u of units) {
    unitSlots(u).forEach((spec, s) => slots.push({ unitId: u.id, slot: s, spec }));
  }

  const filledSlots = new Set();
  for (const p of pinned) {
    if (p.extra) continue;
    const unit = unitById[p.unitId];
    const driver = driverById[p.driverId];
    const key = p.unitId + '#' + p.slot;
    if (!unit || !driver || usedDrivers.has(driver.id) || filledSlots.has(key)) continue;
    if (!slots.some((s) => s.unitId === p.unitId && s.slot === p.slot)) continue;
    if (!canServe(driver, unit, p.slot)) continue;
    usedDrivers.add(driver.id);
    filledSlots.add(key);
    result.push({ date, unitId: p.unitId, slot: p.slot, driverId: driver.id, manual: !!p.manual });
  }

  const openSlots = slots.filter((s) => !filledSlots.has(s.unitId + '#' + s.slot));
  const freeDrivers = drivers.filter((d) => !usedDrivers.has(d.id));

  if (openSlots.length) {
    const hist = historyBefore(db, date);
    const duties = freeDrivers.map((d) => effectiveDuty(db, d, hist));
    const minDuty = duties.length ? Math.min(...duties) : 0;
    const shortages = units.map((u) => hist.unfilled[u.id] || 0);
    const minShort = Math.min(...shortages);
    const shortOf = (unitId) => Math.min(50, (hist.unfilled[unitId] || 0) - minShort);

    const cost = openSlots.map((slot) => {
      const unit = unitById[slot.unitId];
      const row = freeDrivers.map((d, i) => {
        if (!canServe(d, unit, slot.slot)) return COST_FORBIDDEN;
        const rest = d.id in hist.last ? Math.min(diffDays(date, hist.last[d.id]), 60) : 60;
        return (
          vehicleCost(slot, d) +
          (duties[i] - minDuty) * W_DUTY +
          (hist.pair[d.id + '|' + unit.id] || 0) * W_PAIR +
          (hist.prevUnit[d.id] === unit.id ? W_REPEAT : 0) -
          rest * W_REST
        );
      });
      // One "nobody" column per slot, so every slot can always be matched.
      for (let k = 0; k < openSlots.length; k++) {
        row.push(
          COST_UNFILLED +
            (MAX_SLOTS - slot.slot) * W_UNFILLED_PRIORITY +
            shortOf(unit.id) * W_UNFILLED_HISTORY
        );
      }
      return row;
    });

    const match = hungarian(cost);
    openSlots.forEach((slot, i) => {
      const j = match[i];
      const ok = j >= 0 && j < freeDrivers.length && cost[i][j] < COST_FORBIDDEN;
      result.push({ date, unitId: slot.unitId, slot: slot.slot, driverId: ok ? freeDrivers[j].id : null, manual: false });
    });
  }

  result.sort((a, b) => {
    const ua = unitById[a.unitId].name;
    const ub = unitById[b.unitId].name;
    return ua.localeCompare(ub) || a.slot - b.slot;
  });
  db.assignments.push(...result);
  return result;
}

// Make sure today and the next `horizonDays - 1` days are planned.
function ensurePlanned(db, today) {
  const horizon = Math.max(1, Math.min(90, Number(db.settings.horizonDays) || 14));
  let changed = false;
  for (let i = 0; i < horizon; i++) {
    const d = addDays(today, i);
    if (!db.generated[d]) {
      planDay(db, d);
      changed = true;
    }
  }
  return changed;
}

function manualFor(db, date) {
  return db.assignments.filter((a) => a.date === date && a.manual && a.driverId);
}

// Re-plan every planned day from `from` onward, keeping manual changes.
function replanFrom(db, from, today) {
  const days = Object.keys(db.generated).filter((d) => d >= from).sort();
  for (const d of days) planDay(db, d, manualFor(db, d));
  ensurePlanned(db, today);
}

// Fix a day with as little change as possible: keep every assignment that is still
// valid and only fill the gaps (e.g. a driver went on leave this morning).
function repairDay(db, date) {
  const keep = db.assignments.filter((a) => a.date === date && a.driverId);
  planDay(db, date, keep);
}

// Drivers who are active, not on leave and not working anywhere on `date`.
function freeDrivers(db, date) {
  const busy = new Set(db.assignments.filter((a) => a.date === date && a.driverId).map((a) => a.driverId));
  return availableDrivers(db, date).filter((d) => !busy.has(d.id));
}

// A unit asks for one more driver on `date` (emergency / shortage).
function addExtra(db, date, unitId, driverId, info = {}) {
  if (!freeDrivers(db, date).some((d) => d.id === driverId)) throw new Error('That driver is no longer free on this day');
  const used = db.assignments.filter((a) => a.date === date && a.unitId === unitId && a.extra).map((a) => a.slot);
  if (used.length >= 5) throw new Error('A unit can take at most 5 extra drivers a day');
  let slot = EXTRA_SLOT;
  while (used.includes(slot)) slot++;
  const a = { date, unitId, slot, driverId, manual: true, extra: true, reason: info.reason || '', requestedBy: info.requestedBy || '' };
  db.assignments.push(a);
  return a;
}

// Call after anything changes (units, drivers, leave, settings).
// Today is repaired minimally; future days are re-planned for best fairness.
function refresh(db, today) {
  if (db.generated[today]) repairDay(db, today);
  replanFrom(db, addDays(today, 1), today);
}

// Manually set who serves a slot. If that driver already had another slot that day,
// the two drivers swap.
function setManual(db, date, unitId, slot, driverId) {
  const day = db.assignments.filter((a) => a.date === date);
  const target = day.find((a) => a.unitId === unitId && a.slot === slot);
  if (!target) throw new Error('No such slot on that day');
  if (target.extra && !driverId) {
    db.assignments = db.assignments.filter((a) => a !== target); // remove the emergency extra
    return;
  }
  const previous = target.driverId;
  if (driverId) {
    const other = day.find((a) => a.driverId === driverId && a !== target);
    if (other) {
      other.driverId = previous;
      other.manual = !!previous;
      if (other.extra && !previous) db.assignments = db.assignments.filter((a) => a !== other);
    }
  }
  target.driverId = driverId || null;
  target.manual = !!driverId;
}

module.exports = {
  planDay,
  ensurePlanned,
  replanFrom,
  repairDay,
  refresh,
  setManual,
  freeDrivers,
  addExtra,
  EXTRA_SLOT,
  alignBaseline,
  historyBefore,
  isWorkingDay,
  onLeave,
  canServe,
  unitSlots,
  normSlot,
  vehicleFit,
  VEHICLES,
  MAX_SLOTS,
  hungarian,
};
