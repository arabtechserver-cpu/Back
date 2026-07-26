const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'require' || process.env.DATABASE_URL.includes('sslmode=require') || process.env.PGSSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
    }
  : {
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT) || 5432,
      database: process.env.PGDATABASE || 'spiderstore',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      ssl: process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
    };

const pool = new Pool(poolConfig);

async function run() {
  try {
    await pool.query('ALTER TABLE categories ADD COLUMN show_in_menu BOOLEAN DEFAULT true');
    console.log('Added show_in_menu to categories successfully');
  } catch (err) {
    console.log('Error (maybe column exists):', err.message);
  }
  process.exit();
}

run();
