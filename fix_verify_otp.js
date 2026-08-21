const fs = require('fs');
let code = fs.readFileSync('routes/customerRoutes.js', 'utf8');

const target = `      if (item.type === 'register') {
        // Complete registration now
        const result = await runQuery(
          'INSERT INTO customers (username, email, password, phone) VALUES (?, ?, ?, ?)',
          [item.username, item.email, item.password, item.phone]
        );`;

const replacement = `      if (item.type === 'register') {
        // Complete registration now
        let referrerId = null;
        if (item.referred_by_code) {
          const referrer = await getQuery('SELECT id FROM customers WHERE referral_code = ?', [item.referred_by_code]);
          if (referrer) referrerId = referrer.id;
        }
        const newRefCode = "REF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2,5).toUpperCase();

        const result = await runQuery(
          'INSERT INTO customers (username, email, password, phone, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?)',
          [item.username, item.email, item.password, item.phone, newRefCode, referrerId]
        );

        if (referrerId) {
          const refCountRow = await getQuery('SELECT COUNT(*) as cnt FROM customers WHERE referred_by = ?', [referrerId]);
          const currentCount = Number(refCountRow ? refCountRow.cnt : 0);
          const referrerObj = await getQuery('SELECT referrals_rewarded FROM customers WHERE id = ?', [referrerId]);
          const rewarded = Number(referrerObj ? referrerObj.referrals_rewarded || 0 : 0);
          if (currentCount - (rewarded * 30) >= 30) {
            await runQuery('UPDATE customers SET balance = balance + 5, referrals_rewarded = referrals_rewarded + 1 WHERE id = ?', [referrerId]);
          }
        }`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('routes/customerRoutes.js', code);
    console.log("Fixed verify-auth-otp registration handling");
} else {
    console.log("Target not found!");
}
