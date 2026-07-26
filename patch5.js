const fs = require('fs');
const path = 'D:/pj/spider-store-front/backend/db.js';
let content = fs.readFileSync(path, 'utf8');

const target = 'fs.renameSync(tmpPath, dbPath);';
const newCode = `try {
      fs.renameSync(tmpPath, dbPath);
    } catch (err) {
      if (err.code === 'EPERM') {
        fs.copyFileSync(tmpPath, dbPath);
        fs.unlinkSync(tmpPath);
      } else {
        throw err;
      }
    }`;

if (content.includes(target)) {
  content = content.replace(target, newCode);
  fs.writeFileSync(path, content, 'utf8');
  console.log('writeDb patched successfully');
} else {
  console.log('Target not found');
}
