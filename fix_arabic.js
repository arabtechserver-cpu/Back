const fs = require('fs');
let code = fs.readFileSync('routes/orderRoutes.js', 'utf8');

const target = `[{ text: '?? ????? ??????', callback_data: \`approve_api_\${orderId}\` }]`;
const replacement = `[{ text: '\u0645\u0648\u0627\u0641\u0642\u0629 \u0648\u0625\u0631\u0633\u0627\u0644 \u0644\u0644\u0645\u0632\u0648\u062F', callback_data: \`approve_api_\${orderId}\` }]`;

code = code.replace(target, replacement);
fs.writeFileSync('routes/orderRoutes.js', code);
console.log("Fixed arabic text");
