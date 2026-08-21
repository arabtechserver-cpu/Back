const fs = require('fs');
const content = fs.readFileSync('db.js', 'utf8');
const start = content.indexOf('function executeJsonAllQuery');
const end = content.indexOf('function executeJsonRunQuery', start);
console.log(content.substring(start, end));
