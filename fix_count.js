const fs = require('fs');
let code = fs.readFileSync('routes/customerRoutes.js', 'utf8');

const target = `    const countRow = await getQuery('SELECT COUNT(*) as cnt FROM customers WHERE referred_by = ?', [req.customer.id]);
    const count = Number(countRow ? countRow.cnt : 0);`;

const replacement = `    const referrals = await allQuery('SELECT * FROM customers WHERE referred_by = ?', [req.customer.id]);
    const count = referrals ? referrals.length : 0;`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('routes/customerRoutes.js', code);
    console.log("Replaced count query in customerRoutes.js");
} else {
    console.log("Target not found!");
}
