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
