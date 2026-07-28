require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query("SELECT * FROM api_providers");
    console.log("API Providers in Postgres:");
    console.table(res.rows);

    const settings = await pool.query("SELECT * FROM settings WHERE key LIKE 'amrr_%'");
    console.log("Settings in Postgres:");
    console.table(settings.rows);
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
