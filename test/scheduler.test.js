const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/scheduler');
const { defaults } = require('../lib/store');
const { addDays } = require('../lib/dates');

function setup(nUnits, vehicleTypes) {
  const db = defaults();
  for (let i = 1; i <= nUnits; i++) db.units.push({ id: 'u' + i, name: 'Unit ' + i, active: true, driversNeeded: 1, vehicleTypes: [] });
  vehicleTypes.forEach((vt, i) => db.drivers.push({ id: 'd' + (i + 1), name: 'Driver ' + (i + 1), active: true, vehicleType: vt }));
  return db;
}
function run(db, from, days) {
  let d = from;
  for (let i = 0; i < days; i++) { S.planDay(db, d); d = addDays(d, 1); }
}
const spread = (obj, ids) => { const v = ids.map((id) => obj[id] || 0); return Math.max(...v) - Math.min(...v); };

test('every driver gets equal duty and rotates through every unit', () => {
  const db = setup(7, ['4W', '4W', '3W', '3W', '2W', '2W', '2W', '4W']);
  run(db, '2026-01-01', 56);
  const h = S.historyBefore(db, '2099-01-01');
  const ids = db.drivers.map((d) => d.id);
  assert.ok(spread(h.duty, ids) <= 1);
  for (const d of ids) {
    const visits = db.units.map((u) => h.pair[d + '|' + u.id] || 0);
    assert.ok(Math.max(...visits) - Math.min(...visits) <= 1, `${d} visits ${visits}`);
  }
});

test('a driver never serves two units on the same day', () => {
  const db = setup(6, ['4W', '3W', '2W', '4W', '3W', '2W', '4W']);
  run(db, '2026-03-01', 30);
  const seen = new Set();
  for (const a of db.assignments) {
    if (!a.driverId) continue;
    const k = a.date + a.driverId;
    assert.ok(!seen.has(k));
    seen.add(k);
  }
});

test('leave and vehicle rules are respected', () => {
  const db = setup(3, ['4W', '2W', '2W', '4W']);
  db.units[0].vehicleTypes = ['4W'];
  db.leaves.push({ id: 'l1', driverId: 'd1', from: '2026-01-02', to: '2026-01-04' });
  run(db, '2026-01-01', 10);
  for (const a of db.assignments) {
    if (a.unitId === 'u1' && a.driverId) assert.ok(['d1', 'd4'].includes(a.driverId));
    if (a.driverId === 'd1') assert.ok(a.date < '2026-01-02' || a.date > '2026-01-04');
  }
});

test('off days are skipped', () => {
  const db = setup(2, ['4W', '4W']);
  db.settings.offDays = [0];
  run(db, '2026-01-04', 7); // 2026-01-04 is a Sunday
  assert.equal(db.assignments.filter((a) => a.date === '2026-01-04').length, 0);
  assert.equal(db.assignments.filter((a) => a.date === '2026-01-05').length, 2);
});

test('fewer drivers than units: shortage rotates between units', () => {
  const db = setup(4, ['4W', '4W', '4W']);
  run(db, '2026-01-01', 40);
  const h = S.historyBefore(db, '2099-01-01');
  assert.ok(spread(h.unfilled, db.units.map((u) => u.id)) <= 1);
});

test('new driver starts level with others (no catch-up flood)', () => {
  const db = setup(3, ['4W', '4W', '4W', '4W']);
  run(db, '2026-01-01', 20);
  const nd = { id: 'd9', name: 'New', active: true, vehicleType: '4W' };
  db.drivers.push(nd);
  S.alignBaseline(db, nd, '2026-01-21');
  run(db, '2026-01-21', 5);
  const newDuties = db.assignments.filter((a) => a.driverId === 'd9').length;
  assert.ok(newDuties <= 5 && newDuties >= 3, 'got ' + newDuties);
});

test('repairing today only replaces the absent driver', () => {
  const db = setup(3, ['4W', '4W', '4W', '4W', '4W']);
  run(db, '2026-01-01', 1);
  const before = db.assignments.map((a) => ({ ...a }));
  const absent = before[0].driverId;
  db.leaves.push({ id: 'l', driverId: absent, from: '2026-01-01', to: '2026-01-01' });
  S.repairDay(db, '2026-01-01');
  const after = db.assignments.filter((a) => a.date === '2026-01-01');
  assert.notEqual(after.find((a) => a.unitId === before[0].unitId).driverId, absent);
  for (const b of before.slice(1)) assert.equal(after.find((a) => a.unitId === b.unitId).driverId, b.driverId);
});

test('manual change swaps drivers on the same day', () => {
  const db = setup(2, ['4W', '4W']);
  run(db, '2026-01-01', 1);
  const [a, b] = db.assignments;
  const da = a.driverId, dbb = b.driverId;
  S.setManual(db, '2026-01-01', a.unitId, 0, dbb);
  assert.equal(a.driverId, dbb);
  assert.equal(b.driverId, da);
});

test('slot vehicle preferences are matched when the drivers exist', () => {
  const db = setup(3, ['2W', '2W', '2W', '3W', '3W', '3W', '4W', '4W', '4W']);
  for (const u of db.units) u.slots = [{ type: '2W' }, { type: '3W' }, { type: '4W' }];
  run(db, '2026-01-01', 20);
  const byId = Object.fromEntries(db.drivers.map((d) => [d.id, d]));
  for (const a of db.assignments) {
    const want = db.units.find((u) => u.id === a.unitId).slots[a.slot].type;
    assert.equal(byId[a.driverId].vehicleType, want);
  }
});

test('a preferred slot uses another vehicle instead of staying empty', () => {
  const db = setup(1, ['4W', '4W']);
  db.units[0].slots = [{ type: '2W' }, { type: '4W' }];
  run(db, '2026-01-01', 3);
  assert.ok(db.assignments.every((a) => a.driverId));
});

test('a strict slot is never given the wrong vehicle', () => {
  const db = setup(1, ['4W', '4W']);
  db.units[0].slots = [{ type: '4W' }, { type: '2W', strict: true }];
  run(db, '2026-01-01', 3);
  for (const a of db.assignments) if (a.slot === 1) assert.equal(a.driverId, null);
});

test('when short of drivers, only the least important slot is left empty', () => {
  const db = setup(3, ['2W', '2W', '2W', '3W', '3W', '4W', '4W', '4W']); // 8 drivers, 9 slots
  for (const u of db.units) u.slots = [{ type: '2W' }, { type: '4W' }, { type: '3W' }];
  run(db, '2026-01-01', 30);
  const empty = db.assignments.filter((a) => !a.driverId);
  assert.equal(empty.length, 30); // exactly one per day
  assert.ok(empty.every((a) => a.slot === 2)); // always the last slot
  const h = S.historyBefore(db, '2099-01-01');
  assert.ok(spread(h.unfilled, db.units.map((u) => u.id)) <= 1); // shortage rotates
});

test('2nd choice is used before any other vehicle, and must-have slots come first', () => {
  // 7 drivers, 9 slots. Each unit: 1) 2W else 3W, 2) 4W else any, 3) 3W else any.
  const db = setup(3, ['2W', '2W', '3W', '4W', '4W', '4W', '4W']);
  for (const u of db.units) u.slots = [{ type: '2W', second: '3W' }, { type: '4W', second: 'ANY' }, { type: '3W', second: 'ANY' }];
  run(db, '2026-01-01', 21);
  const byId = Object.fromEntries(db.drivers.map((d) => [d.id, d]));
  for (const a of db.assignments) {
    if (a.slot === 0) assert.ok(a.driverId && ['2W', '3W'].includes(byId[a.driverId].vehicleType));
    if (a.slot === 1) assert.ok(a.driverId && byId[a.driverId].vehicleType === '4W');
  }
  assert.equal(db.assignments.filter((a) => !a.driverId && a.slot !== 2).length, 0);
});

test('"1st choice only" slot stays empty rather than take another vehicle', () => {
  const db = setup(1, ['4W', '4W']);
  db.units[0].slots = [{ type: '4W', second: 'ANY' }, { type: '2W', second: 'NONE' }];
  run(db, '2026-01-01', 3);
  for (const a of db.assignments) if (a.slot === 1) assert.equal(a.driverId, null);
});
