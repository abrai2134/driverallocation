// Tiny JSON-file database. Fine for a few dozen units/drivers and years of history.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function defaults() {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString('hex'),
    settings: {
      orgName: 'Driver Allocation',
      timezone: 'Asia/Kolkata',
      offDays: [], // 0 = Sunday ... 6 = Saturday
      holidays: [], // 'YYYY-MM-DD'
      horizonDays: 14, // how many days ahead to plan automatically
      photoDays: 120, // delivery photos older than this are deleted to save disk space
    },
    admins: [],
    units: [],
    drivers: [],
    leaves: [],
    assignments: [], // { date, unitId, slot, driverId|null, manual }
    trips: [], // deliveries: pickup / drop times, photos, signatures
    generated: {}, // { 'YYYY-MM-DD': true } days already planned
  };
}

function normalize(data) {
  const base = defaults();
  const db = { ...base, ...data };
  db.settings = { ...base.settings, ...(data.settings || {}) };
  for (const key of ['admins', 'units', 'drivers', 'leaves', 'assignments', 'trips']) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  if (!db.generated || typeof db.generated !== 'object') db.generated = {};
  if (!db.secret) db.secret = base.secret;
  return db;
}

class Store {
  constructor(file) {
    this.file = file;
    if (file && fs.existsSync(file)) {
      this.db = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
      this.db = defaults();
      this.save();
    }
  }

  save() {
    if (!this.file) return; // in-memory (tests)
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  replace(data) {
    const secret = this.db.secret;
    this.db = normalize(data);
    this.db.secret = secret; // keep sessions signing key stable
    this.save();
  }
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

module.exports = { Store, newId, defaults, normalize };
