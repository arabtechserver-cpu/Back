const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.all("PRAGMA table_info(categories);", (err, rows) => {
  console.log('categories columns:', rows.map(r => r.name));
});

db.all("PRAGMA table_info(services);", (err, rows) => {
  console.log('services columns:', rows.map(r => r.name));
});
