const fs = require('fs');
let code = fs.readFileSync('routes/customerRoutes.js', 'utf8');

const target = `let customer = await getQuery('SELECT referral_code FROM customers WHERE id = ?', [req.customer.id]);`;
const replacement = `let customer = await getQuery('SELECT * FROM customers WHERE id = ?', [req.customer.id]);`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('routes/customerRoutes.js', code);
    console.log("Replaced target in customerRoutes.js");
} else {
    console.log("Target not found in customerRoutes.js");
}
