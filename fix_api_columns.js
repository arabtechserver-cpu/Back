const { runQuery } = require('./db');

async function fixColumns() {
  try {
    await runQuery(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_api_order BOOLEAN DEFAULT false;`);
    await runQuery(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_reseller_id INT REFERENCES customers(id) ON DELETE SET NULL;`);
    await runQuery(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS custom_fields TEXT DEFAULT '';`);
    await runQuery(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_source VARCHAR(100) DEFAULT '';`);
    await runQuery(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_service_id VARCHAR(100) DEFAULT '';`);
    console.log("Successfully added API columns to orders table.");
  } catch (e) {
    console.error("Error adding columns:", e);
  } finally {
    process.exit(0);
  }
}

fixColumns();
