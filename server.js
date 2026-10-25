const path = require('path');
const express = require('express');
const { Store, newId } = require('./lib/store');
const { Files } = require('./lib/files');
const auth = require('./lib/auth');
const S = require('./lib/scheduler');
const { todayIn, addDays, range, isValid } = require('./lib/dates');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = new Store(path.join(DATA_DIR, 'db.json'));
const db = () => store.db;
const files = new Files(path.join(DATA_DIR, 'uploads'));
if (!Array.isArray(store.db.trips)) store.db.trips = [];
if (!store.db.settings.photoDays) store.db.settings.photoDays = 120;

const VEHICLE_TYPES = ['4W', '3W', '2W'];
const SESSION_DAYS = 30;
const COOKIE = 'da_session';

// ---------- first run: create the admin account ----------
if (db().admins.length === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db().admins.push({ id: newId('adm'), username, passHash: auth.hashPassword(password) });
  store.save();
  console.log(`Created admin account "${username}". Log in and change the password.`);
}

const today = () => todayIn(db().settings.timezone);

function plan() {
  if (S.ensurePlanned(db(), today())) store.save();
}

function changed() {
  S.refresh(db(), today());
  store.save();
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple brute-force protection for login.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, since: now };
  if (now - rec.since > 15 * 60 * 1000) {
    rec.count = 0;
    rec.since = now;
  }
  attempts.set(ip, rec);
  return rec;
}

function findAccount(role, id) {
  if (role === 'admin') return db().admins.find((a) => a.id === id);
  if (role === 'unit') return db().units.find((u) => u.id === id && u.active && !u.deleted);
  if (role === 'driver') return db().drivers.find((d) => d.id === id && d.active && !d.deleted);
  return null;
}

app.use((req, res, next) => {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  const session = auth.readToken(token, db().secret);
  if (session) {
    const account = findAccount(session.role, session.id);
    if (account) req.user = { role: session.role, id: session.id, account };
  }
  next();
});

function need(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) return res.status(401).json({ error: 'Please log in' });
    next();
  };
}

const bad = (res, msg) => res.status(400).json({ error: msg });
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const norm = (v) => str(v).toLowerCase();

// ---------- public ----------
app.get('/api/public', (req, res) => {
  res.json({ orgName: db().settings.orgName, vehicleTypes: VEHICLE_TYPES, timezone: db().settings.timezone });
});

app.post('/api/login', (req, res) => {
  const rec = tooMany(req.ip);
  if (rec.count >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const role = str(req.body.role);
  const username = norm(req.body.username);
  const password = String(req.body.password || '');
  let account = null;
  if (role === 'admin') account = db().admins.find((a) => a.username.toLowerCase() === username);
  if (role === 'unit') account = db().units.find((u) => !u.deleted && u.active && (u.username || '').toLowerCase() === username);
  if (role === 'driver') account = db().drivers.find((d) => !d.deleted && d.active && (d.username || '').toLowerCase() === username);
  if (!account || !auth.verifyPassword(password, account.passHash)) {
    rec.count++;
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  rec.count = 0;
  const token = auth.signToken({ role, id: account.id, exp: Date.now() + SESSION_DAYS * 86400000 }, db().secret);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`
  );
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ role: null });
  const a = req.user.account;
  res.json({ role: req.user.role, name: a.name || a.username });
});

// ---------- shared view helpers ----------
function unitView(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    contactName: u.contactName || '',
    phone: u.phone || '',
    address: u.address || '',
    driversNeeded: S.unitSlots(u).length,
    slots: S.unitSlots(u),
    vehicleTypes: u.vehicleTypes || [],
    username: u.username || '',
    active: !!u.active,
  };
}

function driverView(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    phone: d.phone || '',
    vehicleType: d.vehicleType,
    vehicleNo: d.vehicleNo || '',
    username: d.username || '',
    active: !!d.active,
  };
}

function dayInfo(date) {
  return { date, working: S.isWorkingDay(db(), date), holiday: (db().settings.holidays || []).includes(date) };
}

function assignmentsBetween(from, to) {
  return db()
    .assignments.filter((a) => a.date >= from && a.date <= to)
    .map((a) => ({ date: a.date, unitId: a.unitId, slot: a.slot, driverId: a.driverId, manual: !!a.manual, extra: !!a.extra, reason: a.reason || '', fromUnitId: a.fromUnitId || null }));
}

// ---------- unit login ----------
app.get('/api/unit/home', need('unit'), (req, res) => {
  plan();
  const u = req.user.account;
  const t = today();
  const days = range(t, addDays(t, 6)).map((date) => ({
    ...dayInfo(date),
    drivers: db()
      .assignments.filter((a) => a.date === date && a.unitId === u.id && a.driverId)
      .map((a) => ({ ...driverView(db().drivers.find((d) => d.id === a.driverId)), slot: a.slot, extra: !!a.extra, reason: a.reason || '' })),
    // Emergency drivers other units took that day, so everyone knows where they are.
    otherExtras: db()
      .assignments.filter((a) => a.date === date && a.extra && a.driverId && a.unitId !== u.id)
      .map((a) => ({ driver: (db().drivers.find((d) => d.id === a.driverId) || {}).name, unit: (db().units.find((x) => x.id === a.unitId) || {}).name, fromMe: a.fromUnitId === u.id })),
  }));
  const trips = db().trips.filter((x) => x.unitId === u.id && x.date === t).sort((a, b) => (a.pickupAt < b.pickupAt ? 1 : -1)).map(tripView);
  res.json({ today: t, unit: unitView(u), days, trips, months: monthly(db().trips.filter((x) => x.unitId === u.id), 6) });
});

function unitDate(req, res) {
  const t = today();
  const date = req.body && req.body.date !== undefined ? req.body.date : req.query.date || t;
  if (!isValid(date) || date < t || date > addDays(t, 6)) {
    bad(res, 'Choose a day from today up to 6 days ahead');
    return null;
  }
  return date;
}

app.get('/api/unit/free', need('unit'), (req, res) => {
  plan();
  const date = unitDate(req, res);
  if (!date) return;
  const name = (id) => (db().units.find((x) => x.id === id) || {}).name || '';
  const order = { free: 0, other: 1, emergency: 2, mine: 3 };
  const drivers = S.driverStatus(db(), date, req.user.id)
    .sort((a, b) => order[a.status] - order[b.status] || a.driver.name.localeCompare(b.driver.name))
    .map((x) => ({ ...driverView(x.driver), status: x.status, at: name(x.unitId) }));
  res.json({ date, drivers });
});

app.post('/api/unit/extra', need('unit'), (req, res) => {
  plan();
  const date = unitDate(req, res);
  if (!date) return;
  const u = req.user.account;
  try {
    S.addExtra(db(), date, u.id, str(req.body.driverId), { reason: str(req.body.reason, 200), requestedBy: 'unit' });
  } catch (e) {
    return bad(res, e.message);
  }
  S.repairDay(db(), date); // refill the slot the driver left, if anyone is free
  S.replanFrom(db(), addDays(date, 1), today()); // keep duty equal on the following days
  store.save();
  res.json({ ok: true });
});

app.post('/api/unit/extra/cancel', need('unit'), (req, res) => {
  const date = unitDate(req, res);
  if (!date) return;
  const u = req.user.account;
  const slot = Number(req.body.slot);
  const before = db().assignments.length;
  db().assignments = db().assignments.filter((a) => !(a.date === date && a.unitId === u.id && a.extra && a.slot === slot));
  if (db().assignments.length === before) return bad(res, 'Nothing to cancel');
  S.repairDay(db(), date); // the driver is free again and can go back
  S.replanFrom(db(), addDays(date, 1), today());
  store.save();
  res.json({ ok: true });
});

// ---------- driver login ----------
app.get('/api/driver/home', need('driver'), (req, res) => {
  plan();
  const d = req.user.account;
  const t = today();
  const days = range(t, addDays(t, 6)).map((date) => {
    const a = db().assignments.find((x) => x.date === date && x.driverId === d.id);
    return {
      ...dayInfo(date),
      extra: !!(a && a.extra),
      onLeave: S.onLeave(db(), d.id, date),
      unit: a ? unitView(db().units.find((u) => u.id === a.unitId)) : null,
    };
  });
  const month = t.slice(0, 7);
  const monthDuties = db().assignments.filter((a) => a.driverId === d.id && a.date.startsWith(month) && a.date <= t).length;
  const trips = db()
    .trips.filter((x) => x.driverId === d.id && (x.date === t || !x.dropAt))
    .sort((a, b) => (a.pickupAt < b.pickupAt ? 1 : -1))
    .map(tripView);
  const units = db().units.filter((x) => x.active && !x.deleted).map((x) => ({ id: x.id, name: x.name }));
  res.json({ today: t, driver: driverView(d), days, monthDuties, trips, units, months: monthly(db().trips.filter((x) => x.driverId === d.id), 1) });
});

// ---------- admin ----------
// ---------- deliveries (pickup / drop) ----------
const PHOTO_FIELDS = ['pickupPhoto', 'pickupSign', 'dropPhoto', 'dropSign'];

function tripView(t) {
  const d = db().drivers.find((x) => x.id === t.driverId) || {};
  const u = db().units.find((x) => x.id === t.unitId) || {};
  const out = {
    id: t.id, date: t.date, driverId: t.driverId, driverName: d.name || '(removed)', vehicleType: d.vehicleType || '',
    unitId: t.unitId, unitName: u.name || '(removed)',
    pickupAt: t.pickupAt, pickupNote: t.pickupNote || '', pickupSigner: t.pickupSigner || '',
    dropAt: t.dropAt || null, dropNote: t.dropNote || '', dropSigner: t.dropSigner || '',
    minutes: t.dropAt ? Math.round((Date.parse(t.dropAt) - Date.parse(t.pickupAt)) / 60000) : null,
    photosRemoved: !!t.photosRemoved,
  };
  for (const f of PHOTO_FIELDS) out[f] = t[f] ? '/api/files/' + t[f] : null;
  return out;
}

function canSeeTrip(user, t) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'driver') return t.driverId === user.id;
  if (user.role === 'unit') return t.unitId === user.id;
  return false;
}

// Photos are served only to people allowed to see that delivery.
app.get('/api/files/:name', (req, res) => {
  const name = req.params.name;
  const t = db().trips.find((x) => PHOTO_FIELDS.some((f) => x[f] === name));
  const p = files.pathOf(name);
  if (!t || !p || !canSeeTrip(req.user, t)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(p);
});

function saveImages(body, kind, saved) {
  const photo = files.saveDataUrl(body.photo, kind);
  saved.push(photo);
  if (!body.signature) throw new Error('Signature is required');
  const sign = files.saveDataUrl(body.signature, 'sign');
  saved.push(sign);
  return { photo, sign };
}

app.post('/api/driver/trips', need('driver'), (req, res) => {
  const d = req.user.account;
  const t = today();
  const unitId = str(req.body.unitId);
  if (!db().units.some((u) => u.id === unitId && !u.deleted)) return bad(res, 'Choose the unit');
  const saved = [];
  try {
    const { photo, sign } = saveImages(req.body, 'pick', saved);
    const trip = {
      id: newId('trip'), date: t, driverId: d.id, unitId,
      pickupAt: new Date().toISOString(), pickupPhoto: photo, pickupSign: sign,
      pickupSigner: str(req.body.signer, 80), pickupNote: str(req.body.note, 300),
      dropAt: null,
    };
    db().trips.push(trip);
    store.save();
    res.json({ ok: true, trip: tripView(trip) });
  } catch (e) {
    saved.forEach((f) => files.remove(f));
    bad(res, e.message);
  }
});

app.post('/api/driver/trips/:id/drop', need('driver'), (req, res) => {
  const trip = db().trips.find((x) => x.id === req.params.id && x.driverId === req.user.id);
  if (!trip) return res.status(404).json({ error: 'Delivery not found' });
  if (trip.dropAt) return bad(res, 'This delivery is already dropped');
  const saved = [];
  try {
    const { photo, sign } = saveImages(req.body, 'drop', saved);
    Object.assign(trip, {
      dropAt: new Date().toISOString(), dropPhoto: photo, dropSign: sign,
      dropSigner: str(req.body.signer, 80), dropNote: str(req.body.note, 300),
    });
    store.save();
    res.json({ ok: true, trip: tripView(trip) });
  } catch (e) {
    saved.forEach((f) => files.remove(f));
    bad(res, e.message);
  }
});

// Completed deliveries grouped by month: [{ month: 'YYYY-MM', count, minutes }], newest first.
function monthly(trips, months = 12) {
  const t = today();
  const out = [];
  let [y, m] = t.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < months; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const list = trips.filter((x) => x.dropAt && x.date.startsWith(key));
    const minutes = list.reduce((n, x) => n + Math.round((Date.parse(x.dropAt) - Date.parse(x.pickupAt)) / 60000), 0);
    out.push({ month: key, count: list.length, minutes });
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

app.get('/api/driver/trips', need('driver'), (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const mine = db().trips.filter((x) => x.driverId === req.user.id);
  const done = mine.filter((x) => x.dropAt && x.date.startsWith(month)).sort((a, b) => (a.dropAt < b.dropAt ? 1 : -1)).map(tripView);
  res.json({ month, trips: done, months: monthly(mine) });
});

// Remove photos older than the retention period (delivery times are kept forever).
function cleanupPhotos() {
  const days = Number(db().settings.photoDays) || 120;
  const cutoff = addDays(today(), -days);
  let changed = false;
  for (const t of db().trips) {
    if (t.date >= cutoff || t.photosRemoved) continue;
    for (const f of PHOTO_FIELDS) {
      if (t[f]) files.remove(t[f]);
      t[f] = null;
    }
    t.photosRemoved = true;
    changed = true;
  }
  if (changed) store.save();
}
cleanupPhotos();
setInterval(cleanupPhotos, 6 * 3600 * 1000).unref();

const admin = express.Router();
admin.use(need('admin'));

admin.get('/data', (req, res) => {
  plan();
  const t = today();
  const from = isValid(req.query.from) ? req.query.from : t;
  let to = isValid(req.query.to) ? req.query.to : addDays(t, 6);
  if (to < from) to = from;
  if (range(from, to).length > 62) to = addDays(from, 61);
  res.json({
    today: t,
    from,
    to,
    settings: db().settings,
    units: db().units.filter((u) => !u.deleted).map(unitView),
    drivers: db().drivers.filter((d) => !d.deleted).map(driverView),
    allUnits: db().units.map((u) => ({ id: u.id, name: u.name })),
    allDrivers: db().drivers.map((d) => ({ id: d.id, name: d.name, vehicleType: d.vehicleType })),
    leaves: db().leaves.slice().sort((a, b) => (a.from < b.from ? 1 : -1)),
    days: range(from, to).map(dayInfo),
    assignments: assignmentsBetween(from, to),
  });
});

admin.get('/stats', (req, res) => {
  const t = today();
  const from = isValid(req.query.from) ? req.query.from : addDays(t, -29);
  const to = isValid(req.query.to) ? req.query.to : t;
  const list = db().assignments.filter((a) => a.date >= from && a.date <= to && a.driverId);
  const drivers = db().drivers.filter((d) => !d.deleted);
  const units = db().units.filter((u) => !u.deleted);
  const rows = drivers.map((d) => {
    const mine = list.filter((a) => a.driverId === d.id);
    const perUnit = {};
    for (const u of units) perUnit[u.id] = mine.filter((a) => a.unitId === u.id).length;
    const leaveDays = range(from, to).filter((date) => S.onLeave(db(), d.id, date)).length;
    return { driverId: d.id, name: d.name, vehicleType: d.vehicleType, active: d.active, total: mine.length, leaveDays, perUnit };
  });
  const unfilled = db().assignments.filter((a) => a.date >= from && a.date <= to && !a.driverId).length;
  res.json({ from, to, units: units.map((u) => ({ id: u.id, name: u.name })), rows, unfilled });
});

function readUnit(body, existing) {
  const name = str(body.name, 80);
  if (!name) return { error: 'Unit name is required' };
  const username = norm(body.username) || name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!/^[a-z0-9._@-]{3,40}$/.test(username)) return { error: 'Login ID must be 3-40 letters/numbers (no spaces)' };
  if (db().units.some((u) => !u.deleted && u !== existing && (u.username || '').toLowerCase() === username)) {
    return { error: 'Another unit already uses this login ID' };
  }
  const password = String(body.password || '');
  if (!existing && password.length < 4) return { error: 'Password must be at least 4 characters' };
  if (existing && password && password.length < 4) return { error: 'Password must be at least 4 characters' };
  const vehicleTypes = Array.isArray(body.vehicleTypes) ? body.vehicleTypes.filter((v) => VEHICLE_TYPES.includes(v)) : [];
  let slots;
  if (Array.isArray(body.slots) && body.slots.length) {
    slots = body.slots.slice(0, S.MAX_SLOTS).map(S.normSlot);
  } else {
    const n = Math.max(1, Math.min(S.MAX_SLOTS, parseInt(body.driversNeeded, 10) || 1));
    slots = Array.from({ length: n }, () => ({ type: 'ANY', second: 'ANY' }));
  }
  return {
    value: {
      name,
      username,
      contactName: str(body.contactName, 80),
      phone: str(body.phone, 30),
      address: str(body.address, 300),
      driversNeeded: slots.length,
      slots,
      vehicleTypes,
      active: body.active !== false,
    },
    password,
  };
}

function readDriver(body, existing) {
  const name = str(body.name, 80);
  if (!name) return { error: 'Driver name is required' };
  const vehicleType = str(body.vehicleType);
  if (!VEHICLE_TYPES.includes(vehicleType)) return { error: 'Choose a vehicle type' };
  const phone = str(body.phone, 30);
  const username = norm(body.username) || phone.replace(/\D/g, '');
  if (!/^[a-z0-9._@-]{3,40}$/.test(username)) return { error: 'Login ID must be 3-40 letters/numbers (no spaces)' };
  if (db().drivers.some((d) => !d.deleted && d !== existing && (d.username || '').toLowerCase() === username)) {
    return { error: 'Another driver already uses this login ID' };
  }
  const password = String(body.password || '');
  if (!existing && password.length < 4) return { error: 'Password/PIN must be at least 4 characters' };
  if (existing && password && password.length < 4) return { error: 'Password/PIN must be at least 4 characters' };
  return {
    value: { name, phone, username, vehicleType, vehicleNo: str(body.vehicleNo, 30), active: body.active !== false },
    password,
  };
}

admin.post('/units', (req, res) => {
  const r = readUnit(req.body);
  if (r.error) return bad(res, r.error);
  db().units.push({ id: newId('unit'), ...r.value, passHash: auth.hashPassword(r.password), createdAt: today() });
  changed();
  res.json({ ok: true });
});

admin.put('/units/:id', (req, res) => {
  const u = db().units.find((x) => x.id === req.params.id && !x.deleted);
  if (!u) return res.status(404).json({ error: 'Unit not found' });
  const r = readUnit(req.body, u);
  if (r.error) return bad(res, r.error);
  Object.assign(u, r.value);
  if (r.password) u.passHash = auth.hashPassword(r.password);
  changed();
  res.json({ ok: true });
});

admin.delete('/units/:id', (req, res) => {
  const u = db().units.find((x) => x.id === req.params.id && !x.deleted);
  if (!u) return res.status(404).json({ error: 'Unit not found' });
  u.deleted = true; // keep history readable
  u.active = false;
  changed();
  res.json({ ok: true });
});

admin.post('/drivers', (req, res) => {
  const r = readDriver(req.body);
  if (r.error) return bad(res, r.error);
  const d = { id: newId('drv'), ...r.value, passHash: auth.hashPassword(r.password), baseline: 0, createdAt: today() };
  db().drivers.push(d);
  if (d.active) S.alignBaseline(db(), d, today());
  changed();
  res.json({ ok: true });
});

admin.put('/drivers/:id', (req, res) => {
  const d = db().drivers.find((x) => x.id === req.params.id && !x.deleted);
  if (!d) return res.status(404).json({ error: 'Driver not found' });
  const r = readDriver(req.body, d);
  if (r.error) return bad(res, r.error);
  const wasActive = d.active;
  Object.assign(d, r.value);
  if (r.password) d.passHash = auth.hashPassword(r.password);
  if (!wasActive && d.active) S.alignBaseline(db(), d, today());
  changed();
  res.json({ ok: true });
});

admin.delete('/drivers/:id', (req, res) => {
  const d = db().drivers.find((x) => x.id === req.params.id && !x.deleted);
  if (!d) return res.status(404).json({ error: 'Driver not found' });
  d.deleted = true;
  d.active = false;
  changed();
  res.json({ ok: true });
});

admin.post('/leaves', (req, res) => {
  const driverId = str(req.body.driverId);
  const from = str(req.body.from);
  const to = str(req.body.to) || from;
  if (!db().drivers.some((d) => d.id === driverId && !d.deleted)) return bad(res, 'Choose a driver');
  if (!isValid(from) || !isValid(to) || to < from) return bad(res, 'Choose valid dates');
  db().leaves.push({ id: newId('lv'), driverId, from, to, reason: str(req.body.reason, 200) });
  changed();
  res.json({ ok: true });
});

admin.delete('/leaves/:id', (req, res) => {
  db().leaves = db().leaves.filter((l) => l.id !== req.params.id);
  changed();
  res.json({ ok: true });
});

admin.post('/assign', (req, res) => {
  const { date, unitId } = req.body;
  const slot = Number(req.body.slot) || 0;
  const driverId = req.body.driverId || null;
  if (!isValid(date)) return bad(res, 'Invalid date');
  if (date < today()) return bad(res, 'Past days cannot be changed');
  if (driverId) {
    const d = db().drivers.find((x) => x.id === driverId && x.active && !x.deleted);
    if (!d) return bad(res, 'Driver not available');
    if (S.onLeave(db(), driverId, date)) return bad(res, `${d.name} is on leave that day`);
    const u = db().units.find((x) => x.id === unitId);
    if (u && !S.canServe(d, u, slot)) return bad(res, `This ${u.name} slot does not accept ${d.vehicleType} vehicles`);
  }
  try {
    S.setManual(db(), date, unitId, slot, driverId);
  } catch (e) {
    return bad(res, e.message);
  }
  S.replanFrom(db(), addDays(date, 1), today());
  store.save();
  res.json({ ok: true });
});

admin.post('/regenerate', (req, res) => {
  const t = today();
  const from = isValid(req.body.from) ? req.body.from : t;
  if (from < t) return bad(res, 'Past days cannot be changed');
  const keepManual = req.body.keepManual !== false;
  if (!keepManual) {
    for (const a of db().assignments) if (a.date >= from) a.manual = false;
  }
  S.replanFrom(db(), from, t);
  store.save();
  res.json({ ok: true });
});

admin.put('/settings', (req, res) => {
  const s = db().settings;
  const b = req.body;
  if (b.orgName !== undefined) s.orgName = str(b.orgName, 80) || 'Driver Allocation';
  if (b.timezone !== undefined) {
    try {
      todayIn(str(b.timezone));
      s.timezone = str(b.timezone);
    } catch {
      return bad(res, 'Unknown time zone');
    }
  }
  if (Array.isArray(b.offDays)) s.offDays = [...new Set(b.offDays.map(Number).filter((n) => n >= 0 && n <= 6))];
  if (Array.isArray(b.holidays)) s.holidays = [...new Set(b.holidays.filter(isValid))].sort();
  if (b.photoDays !== undefined) s.photoDays = Math.max(7, Math.min(3650, parseInt(b.photoDays, 10) || 120));
  if (b.horizonDays !== undefined) s.horizonDays = Math.max(1, Math.min(60, parseInt(b.horizonDays, 10) || 14));
  changed();
  res.json({ ok: true });
});

admin.post('/password', (req, res) => {
  const a = req.user.account;
  if (!auth.verifyPassword(String(req.body.current || ''), a.passHash)) return bad(res, 'Current password is wrong');
  const next = String(req.body.next || '');
  if (next.length < 6) return bad(res, 'New password must be at least 6 characters');
  const username = norm(req.body.username);
  if (username) a.username = username;
  a.passHash = auth.hashPassword(next);
  store.save();
  res.json({ ok: true });
});

admin.get('/backup', (req, res) => {
  const { secret, ...rest } = db();
  res.setHeader('Content-Disposition', `attachment; filename="driver-allocation-backup-${today()}.json"`);
  res.json(rest);
});

admin.post('/restore', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.units) || !Array.isArray(data.drivers) || !Array.isArray(data.admins) || !data.admins.length) {
    return bad(res, 'This does not look like a backup file');
  }
  store.replace(data);
  plan();
  res.json({ ok: true });
});

function tripsBetween(from, to) {
  return db().trips.filter((x) => x.date >= from && x.date <= to).sort((a, b) => (a.pickupAt < b.pickupAt ? 1 : -1));
}

admin.get('/trips', (req, res) => {
  const t = today();
  const from = isValid(req.query.from) ? req.query.from : t;
  const to = isValid(req.query.to) && req.query.to >= from ? req.query.to : from;
  const list = tripsBetween(from, to).map(tripView);
  const byDriver = {};
  for (const tr of list) {
    const r = (byDriver[tr.driverId] ||= { driverId: tr.driverId, name: tr.driverName, vehicleType: tr.vehicleType, done: 0, open: 0, minutes: 0 });
    if (tr.dropAt) { r.done++; r.minutes += tr.minutes; } else r.open++;
  }
  const summary = Object.values(byDriver).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
  res.json({ from, to, trips: list, summary });
});

// Month-wise completed deliveries per driver and per unit (last 6 months).
admin.get('/trips/monthly', (req, res) => {
  const n = Math.max(1, Math.min(24, parseInt(req.query.months, 10) || 6));
  const months = monthly([], n).map((x) => x.month);
  const drivers = db().drivers.filter((d) => !d.deleted || db().trips.some((x) => x.driverId === d.id))
    .map((d) => ({ id: d.id, name: d.name, vehicleType: d.vehicleType, months: monthly(db().trips.filter((x) => x.driverId === d.id), n) }));
  const units = db().units.filter((u) => !u.deleted || db().trips.some((x) => x.unitId === u.id))
    .map((u) => ({ id: u.id, name: u.name, months: monthly(db().trips.filter((x) => x.unitId === u.id), n) }));
  res.json({ months, drivers, units });
});

admin.get('/trips.csv', (req, res) => {
  const t = today();
  const from = isValid(req.query.from) ? req.query.from : t;
  const to = isValid(req.query.to) && req.query.to >= from ? req.query.to : from;
  const tz = db().settings.timezone;
  const time = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: tz }) : '');
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Driver', 'Vehicle', 'Unit', 'Pickup time', 'Pickup signed by', 'Pickup note', 'Drop time', 'Drop signed by', 'Drop note', 'Minutes']];
  for (const tr of tripsBetween(from, to).map(tripView)) {
    rows.push([tr.date, tr.driverName, tr.vehicleType, tr.unitName, time(tr.pickupAt), tr.pickupSigner, tr.pickupNote, time(tr.dropAt), tr.dropSigner, tr.dropNote, tr.minutes ?? 'not dropped']);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="deliveries-${from}-to-${to}.csv"`);
  res.send('\ufeff' + rows.map((r) => r.map(q).join(',')).join('\r\n'));
});

admin.delete('/trips/:id', (req, res) => {
  const trip = db().trips.find((x) => x.id === req.params.id);
  if (!trip) return res.status(404).json({ error: 'Not found' });
  for (const f of PHOTO_FIELDS) if (trip[f]) files.remove(trip[f]);
  db().trips = db().trips.filter((x) => x !== trip);
  store.save();
  res.json({ ok: true });
});

app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.set('trust proxy', 1);
  app.listen(PORT, () => console.log(`Driver allocation running on http://localhost:${PORT}`));
}

module.exports = app;
