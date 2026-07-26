const fs = require('fs');
const path = 'D:/pj/spider-store-front/backend/routes/orderRoutes.js';
let content = fs.readFileSync(path, 'utf8');

const oldText = "const orders = (await allQuery('SELECT * FROM orders ORDER BY id DESC')) || [];";
const newText = "const orders = (await allQuery('SELECT o.*, s.api_provider_id FROM orders o LEFT JOIN services s ON o.service_id = s.id ORDER BY o.id DESC')) || [];";

if (content.includes(oldText)) {
  fs.writeFileSync(path, content.replace(oldText, newText), 'utf8');
  console.log('Replaced');
} else {
  console.log('Not found');
}
