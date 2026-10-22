// Fills an empty database with sample units and drivers so you can try the app.
// Usage: npm run demo   (then npm start)
const path = require('path');
const { Store, newId } = require('../lib/store');
const { hashPassword } = require('../lib/auth');

const store = new Store(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'db.json'));
const db = store.db;
if (db.units.length || db.drivers.length) {
  console.log('Database already has units/drivers - demo data not added.');
  process.exit(0);
}
const units = ['Andheri', 'Bandra', 'Borivali', 'Dadar', 'Kurla', 'Thane', 'Vashi'];
units.forEach((name, i) => {
  db.units.push({
    id: newId('unit'), name: name + ' Unit', username: 'unit' + (i + 1), passHash: hashPassword('unit' + (i + 1)),
    contactName: name + ' Manager', phone: '98200000' + String(i + 1).padStart(2, '0'), address: name + ', Mumbai',
    driversNeeded: 1, vehicleTypes: [], active: true,
  });
});
const drivers = [
  ['Ramesh', '4W'], ['Suresh', '4W'], ['Imran', '4W'], ['Mahesh', '3W'],
  ['Salim', '3W'], ['Ganesh', '2W'], ['Rahul', '2W'], ['Akbar', '2W'],
];
drivers.forEach(([name, vehicleType], i) => {
  const phone = '99300000' + String(i + 1).padStart(2, '0');
  db.drivers.push({
    id: newId('drv'), name, phone, username: phone, passHash: hashPassword('1234'),
    vehicleType, vehicleNo: 'MH 02 AB ' + (1000 + i), active: true, baseline: 0,
  });
});
store.save();
console.log('Demo data added.');
console.log('Unit logins:   unit1 / unit1 ... unit7 / unit7');
console.log('Driver logins: 9930000001 / 1234 ... 9930000008 / 1234');
