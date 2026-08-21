const fs = require('fs');
let code = fs.readFileSync('routes/customerRoutes.js', 'utf8');

const target = `    let customer = await getQuery('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
    if (!customer.referral_code) {`;
const replacement = `    let customer = await getQuery('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    if (!customer.referral_code) {`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('routes/customerRoutes.js', code);
    console.log("Added customer check");
} else {
    console.log("Target not found!");
}
