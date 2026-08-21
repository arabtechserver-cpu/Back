const fs = require('fs');
let code = fs.readFileSync('db.js', 'utf8');

const target = `    ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) DEFAULT 0;`;

const replacement = `    ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) DEFAULT 0;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50) UNIQUE DEFAULT NULL;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by INT DEFAULT NULL;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS referrals_rewarded INT DEFAULT 0;`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('db.js', code);
    console.log("Done");
} else {
    console.log("Target not found!");
}
