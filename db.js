const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { removeLegacySerialDuplicate } = require('./services/providerFieldCleanup');
const dbEvents = require('./utils/dbEvents');
require('dotenv').config();

// ──────────────────────────────────────────────────────────────────────────────
// PostgreSQL Connection Pool
// ──────────────────────────────────────────────────────────────────────────────
const poolConfig = process.env.DATABASE_URL
  ? {
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PGPOOL_MAX) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
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

pool.on('error', (err) => {
  if (!fallbackMode) {
    console.error('Unexpected PostgreSQL pool error:', err.message);
    dbEvents.emit('database-alert', {
      level: 'error',
      type: 'postgres-pool-error',
      message: `Unexpected PostgreSQL pool error: ${err.message}`,
      fallbackMode,
      timestamp: new Date().toISOString(),
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// JSON Database Fallback Driver
// ──────────────────────────────────────────────────────────────────────────────
let fallbackMode = process.env.USE_LOCAL_JSON_DB === 'true';
const dbPath = path.join(__dirname, 'database.json');
const defaultJsonDb = {
  users: [],
  categories: [],
  services: [],
  orders: [],
  customers: [],
  banners: [],
  wallet_requests: [],
  wallet_transactions: [],
  settings: [
    { key: "site_name", value: "عرب تك سيرفر" },
    { key: "site_logo", value: "/logo.jpg" },
    { key: "site_favicon", value: "/favicon.png" }
  ],
  customer_discounts: [],
  reviews: [],
  api_providers: [],
  conversion_events: []
};

function ensureDefaultSettings(data) {
  if (!data.settings) {
    data.settings = [...defaultJsonDb.settings];
  }
  if (!data.users || data.users.length === 0) {
    data.users = [{
      id: 1,
      username: 'admin',
      password: bcrypt.hashSync('admin123', 10)
    }];
  }
  return data;
}

function setFallbackMode(nextMode, reason = '') {
  const previousMode = fallbackMode;
  fallbackMode = nextMode;

  if (previousMode !== nextMode) {
    dbEvents.emit('database-mode-change', {
      fallbackMode,
      reason,
      timestamp: new Date().toISOString(),
    });
  }
}

let dbInitializedResolve;
const dbInitialized = new Promise((resolve) => {
  dbInitializedResolve = resolve;
});

let cachedDb = null;
let lastDbMtime = 0;

function readDb() {
  if (!fs.existsSync(dbPath)) {
    if (!cachedDb) {
      cachedDb = ensureDefaultSettings({ ...defaultJsonDb });
      writeDb(cachedDb);
    }
    return cachedDb;
  }

  try {
    const stats = fs.statSync(dbPath);
    if (cachedDb && stats.mtimeMs === lastDbMtime) {
      return cachedDb;
    }
    
    const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    cachedDb = ensureDefaultSettings(data);
    lastDbMtime = stats.mtimeMs;
    return cachedDb;
  } catch (err) {
    console.error('Failed to read JSON fallback database:', err.message);
    const backupPath = `${dbPath}.corrupt-${Date.now()}`;
    try {
      if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, backupPath);
      console.warn('Backed up corrupted JSON database to:', backupPath);
    } catch (copyErr) {
      console.warn('Could not back up corrupted JSON database:', copyErr.message);
    }
    if (!cachedDb) {
      cachedDb = ensureDefaultSettings({ ...defaultJsonDb });
      writeDb(cachedDb);
    }
    return cachedDb;
  }
}

let isWriting = false;
let writePending = false;

function writeDb(data) {
  cachedDb = data;
  const finalData = ensureDefaultSettings({ ...data });
  
  if (isWriting) {
    writePending = true;
    return;
  }
  
  isWriting = true;
  writePending = false;
  
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFile(tmpPath, JSON.stringify(finalData, null, 2), (err) => {
    if (err) {
      console.error('Error writing temp db:', err);
      isWriting = false;
      if (writePending) writeDb(cachedDb);
      return;
    }
    
    fs.rename(tmpPath, dbPath, (err) => {
      if (err) {
        if (err.code === 'EPERM') {
          fs.copyFile(tmpPath, dbPath, (err) => {
            if (!err) fs.unlink(tmpPath, () => {});
            finishWrite();
          });
        } else {
          console.error('Error renaming temp db:', err);
          finishWrite();
        }
      } else {
        finishWrite();
      }
    });
  });
  
  function finishWrite() {
    try {
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        lastDbMtime = stats.mtimeMs;
      }
    } catch(e) {}
    isWriting = false;
    if (writePending) {
      writeDb(cachedDb);
    }
  }
}

function executeJsonRunQuery(sql, params = []) {
  const trimmed = sql.trim().toUpperCase();

  if (trimmed === 'BEGIN TRANSACTION' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
    return { lastID: null, changes: 0 };
  }

  if (trimmed.startsWith('INSERT')) {
    const tableMatch = sql.match(/insert\s+into\s+(\w+)/i);
    if (!tableMatch) throw new Error('Invalid INSERT statement');
    const table = tableMatch[1].toLowerCase();

    const colsMatch = sql.match(/\(([^)]+)\)/);
    if (!colsMatch) throw new Error('Invalid INSERT statement columns');
    const cols = colsMatch[1].split(',').map(c => c.trim());

    const db = readDb();
    if (!db[table]) db[table] = [];

    const newRow = {};
    const maxId = db[table].reduce((max, r) => Math.max(max, r.id || 0), 0);
    newRow.id = maxId + 1;

    cols.forEach((col, index) => {
      let val = params[index];
      // Try to parse stringified JSON for packages/fields if necessary
      if ((col === 'packages' || col === 'fields') && typeof val === 'string') {
        try {
          // Keep as string or parse depends on what's expected. 
          // SQLite uses strings, PG uses JSON/TEXT. Let's keep it as is.
        } catch { }
      }
      newRow[col] = val;
    });

    // Check UNIQUE constraints
    if (table === 'categories') {
      const exists = db[table].some(r => String(r.name).toLowerCase() === String(newRow.name).toLowerCase());
      if (exists) {
        const error = new Error('UNIQUE constraint failed');
        error.message = 'UNIQUE constraint failed';
        throw error;
      }
    }
    if (table === 'customers' || table === 'users') {
      const exists = db[table].some(r => String(r.username).toLowerCase() === String(newRow.username).toLowerCase());
      if (exists) {
        const error = new Error('UNIQUE constraint failed');
        error.message = 'UNIQUE constraint failed';
        throw error;
      }
    }

    if (table === 'orders' || table === 'wallet_requests' || table === 'wallet_transactions' || table === 'conversion_events') {
      newRow.created_at = newRow.created_at || new Date().toISOString();
    }
    if (table === 'orders') {
      newRow.status = newRow.status || 'pending';
    }

    db[table].push(newRow);
    writeDb(db);
    return { lastID: newRow.id, changes: 1 };
  }

  if (trimmed.startsWith('UPDATE')) {
    const tableMatch = sql.match(/update\s+(\w+)/i);
    if (!tableMatch) throw new Error('Invalid UPDATE statement');
    const table = tableMatch[1].toLowerCase();

    const db = readDb();
    const rows = db[table] || [];

    if (table === 'settings') {
      const setMatch = sql.match(/set\s+value\s*=\s*\?/i);
      const whereMatch = sql.match(/where\s+key\s*=\s*\?/i);
      if (setMatch && whereMatch) {
        const val = params[0];
        const key = params[1];
        const rowIndex = rows.findIndex(r => r.key === key);
        if (rowIndex !== -1) {
          rows[rowIndex].value = val;
        } else {
          rows.push({ key, value: val });
        }
        db[table] = rows;
        writeDb(db);
        return { lastID: null, changes: 1 };
      }
    }

    const setMatch = sql.match(/set\s+(.+?)(?:\s+where\s+(.+)|$)/i);
    if (!setMatch) throw new Error('Invalid UPDATE statement SET clause');
    const setClause = setMatch[1];
    const whereClause = setMatch[2];

    // Check if updating without a WHERE clause (e.g. UPDATE categories SET currency = 'USD')
    if (!whereClause) {
      let changes = 0;
      rows.forEach((row, rIdx) => {
        const assignments = setClause.split(',').map(s => s.trim());
        let paramIdx = 0;
        assignments.forEach(assign => {
          const parts = assign.split('=').map(p => p.trim());
          const col = parts[0];
          const valExpr = parts[1];
          if (valExpr === '?') {
            row[col] = params[paramIdx++];
          } else if (valExpr.startsWith("'") && valExpr.endsWith("'")) {
            row[col] = valExpr.slice(1, -1);
          } else if (!isNaN(Number(valExpr))) {
            row[col] = Number(valExpr);
          } else {
            row[col] = valExpr;
          }
        });
        db[table][rIdx] = row;
        changes++;
      });
      writeDb(db);
      return { lastID: null, changes };
    }

    const setCols = setClause.split(',').map(c => c.split('=')[0].trim());
    const idVal = params[params.length - 1];

    const rowIndex = rows.findIndex(r => r.id === Number(idVal));
    if (rowIndex === -1) {
      return { lastID: null, changes: 0 };
    }

    const row = rows[rowIndex];

    if (sql.includes('balance = balance +')) {
      row.balance = Number(row.balance || 0) + Number(params[0]);
    } else if (sql.includes('balance = balance -')) {
      if (sql.includes('AND balance >=')) {
        const checkAmount = params[params.length - 1]; // the last parameter is the balance check in 'WHERE id = ? AND balance >= ?'
        if (Number(row.balance || 0) < Number(checkAmount)) {
          return { lastID: null, changes: 0 }; // Insufficient balance
        }
      }
      row.balance = Number(row.balance || 0) - Number(params[0]);
    } else {
      setCols.forEach((col, index) => {
        const valExpr = setClause.split(',')[index].split('=')[1].trim();
        if (valExpr === '?') {
          row[col] = params[index];
        } else if (valExpr.startsWith("'") && valExpr.endsWith("'")) {
          row[col] = valExpr.slice(1, -1);
        } else if (!isNaN(Number(valExpr))) {
          row[col] = Number(valExpr);
        } else {
          row[col] = params[index];
        }
      });
    }

    db[table][rowIndex] = row;
    writeDb(db);
    return { lastID: null, changes: 1 };
  }

  if (trimmed.startsWith('DELETE')) {
    const tableMatch = sql.match(/delete\s+from\s+(\w+)/i);
    if (!tableMatch) throw new Error('Invalid DELETE statement');
    const table = tableMatch[1].toLowerCase();

    const idVal = params[0];
    const db = readDb();
    const initialLength = (db[table] || []).length;
    if (db[table]) {
      db[table] = db[table].filter(r => r.id !== Number(idVal));
    }
    writeDb(db);
    return { lastID: null, changes: initialLength - (db[table] || []).length };
  }

  throw new Error('Unsupported write query in JSON mode: ' + sql);
}

function executeJsonAllQuery(sql, params = []) {
  const db = readDb();

  // Handle the specific order serviceInfo join query
  if (sql.includes('s.name as service_name') && sql.includes('c.name as category_name')) {
    const serviceId = params[0];
    const service = db.services.find(s => s.id === Number(serviceId));
    if (!service) return [];
    const category = db.categories.find(c => c.id === Number(service.category_id));
    return [{
      service_name: service.name,
      category_name: category ? category.name : ''
    }];
  }

  // Handle services join with category currency (all services or by category_id or single service by id)
  if (sql.includes('category_currency') && sql.includes('services')) {
    let rows = db.services || [];

    // Check if filtering by category_id
    if (sql.includes('category_id = ?') || sql.includes('category_id = $') || sql.includes('s.category_id = ?') || sql.includes('s.category_id = $')) {
      const categoryId = params[0];
      rows = rows.filter(s => Number(s.category_id) === Number(categoryId));
    }
    // Check if filtering by service id
    else if (sql.includes('id = ?') || sql.includes('id = $') || sql.includes('s.id = ?') || sql.includes('s.id = $')) {
      const serviceId = params[0];
      rows = rows.filter(s => Number(s.id) === Number(serviceId));
    }

    // Map each service to include category_currency
    const joinedRows = rows.map(service => {
      const category = db.categories.find(c => c.id === Number(service.category_id));
      return {
        ...service,
        category_currency: category ? (category.currency || 'EGP') : 'EGP',
        category_fields: category ? (category.fields || '[]') : '[]',
        category_fields_title: category ? (category.fields_title || 'بيانات الخدمة') : 'بيانات الخدمة'
      };
    });

    if (/order\s+by/i.test(sql)) {
      const desc = /desc/i.test(sql);
      joinedRows.sort((a, b) => desc ? b.id - a.id : a.id - b.id);
    }
    return joinedRows;
  }

  if (sql.toLowerCase().includes('count(')) {
    const match = sql.match(/from\s+(\w+)/i);
    if (match) {
      const table = match[1].toLowerCase();
      return [{ count: db[table] ? db[table].length : 0 }];
    }
    return [{ count: 0 }];
  }

  const tableMatch = sql.match(/from\s+(\w+)/i);
  if (!tableMatch) return [];
  const table = tableMatch[1].toLowerCase();

  let rows = db[table] || [];

  const whereMatch = sql.match(/where\s+(.+?)(?:\s+order\s+by|\s+group\s+by|\s+limit|\s*$)/i);
  if (whereMatch) {
    const whereClause = whereMatch[1];
    const conditions = whereClause.split(/\s+AND\s+/i);
    let paramIdx = 0;

    const parsedConditions = conditions.map(cond => {
      const condStr = cond.trim();
      if (/is\s+not\s+null/i.test(condStr)) {
        const col = condStr.split(/\s+is\s+not\s+null/i)[0].trim().replace(/^\w+\./, '');
        return { type: 'not_null', col };
      }
      if (/is\s+null/i.test(condStr)) {
        const col = condStr.split(/\s+is\s+null/i)[0].trim().replace(/^\w+\./, '');
        return { type: 'null', col };
      }
      const parts = condStr.split(/\s*=\s*/);
      if (parts.length >= 2) {
        const col = parts[0].trim().replace(/^\w+\./, '');
        let valStr = parts.slice(1).join('=').trim();
        let val;
        if (valStr === '?' || valStr.startsWith('$')) {
          val = params[paramIdx++];
        } else {
          val = valStr.replace(/^['"]|['"]$/g, '');
        }
        return { type: 'eq', col, val };
      }
      return null;
    }).filter(Boolean);

    rows = rows.filter(row => {
      return parsedConditions.every(cond => {
        if (cond.type === 'not_null') {
          return row[cond.col] !== null && row[cond.col] !== undefined && row[cond.col] !== '';
        }
        if (cond.type === 'null') {
          return row[cond.col] === null || row[cond.col] === undefined || row[cond.col] === '';
        }
        if (cond.type === 'eq') {
          if (typeof row[cond.col] === 'number') {
            return row[cond.col] === Number(cond.val);
          }
          if (row[cond.col] == null) return false;
          return String(row[cond.col]).toLowerCase() === String(cond.val).toLowerCase();
        }
        return true;
      });
    });
  }

  if (/order\s+by/i.test(sql)) {
    const desc = /desc/i.test(sql);
    rows.sort((a, b) => desc ? b.id - a.id : a.id - b.id);
  }

  return rows;
}

function executeJsonGetQuery(sql, params = []) {
  const rows = executeJsonAllQuery(sql, params);
  return rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Schema initialisation for PostgreSQL (Not run in Fallback Mode)
// ──────────────────────────────────────────────────────────────────────────────
async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id       SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id       SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email    VARCHAR(255) DEFAULT '',
      phone    VARCHAR(100) DEFAULT '',
      balance  NUMERIC(12,2) DEFAULT 0,
      balances TEXT DEFAULT '{"USD":0,"USDT":0}',
      password_plain VARCHAR(255) DEFAULT '',
      reset_otp VARCHAR(20) DEFAULT NULL,
      reset_otp_expires TIMESTAMPTZ DEFAULT NULL,
      google_id VARCHAR(255) DEFAULT '',
      transaction_password VARCHAR(255) DEFAULT ''
    );

    ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) DEFAULT '';
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS transaction_password VARCHAR(255) DEFAULT '';
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS visits_count INT DEFAULT 0;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) DEFAULT 0;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50) UNIQUE DEFAULT NULL;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by INT DEFAULT NULL;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS referrals_rewarded INT DEFAULT 0;

    CREATE TABLE IF NOT EXISTS user_passkeys (
      id SERIAL PRIMARY KEY,
      customer_id INT NOT NULL,
      credential_id TEXT UNIQUE NOT NULL,
      public_key TEXT NOT NULL,
      counter INT DEFAULT 0,
      transports TEXT DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  VARCHAR(200) UNIQUE NOT NULL,
      image TEXT DEFAULT 'default',
      color VARCHAR(50) DEFAULT '#6366f1',
      icon  VARCHAR(100) DEFAULT 'credit-card',
      currency VARCHAR(20) DEFAULT 'EGP',
      fields TEXT DEFAULT '[]',
      fields_title VARCHAR(255) DEFAULT 'بيانات الخدمة',
      parent_id INT REFERENCES categories(id) ON DELETE SET NULL DEFAULT NULL,
      show_in_menu BOOLEAN DEFAULT false,
      menu_service_type VARCHAR(20) DEFAULT '',
      linked_categories TEXT DEFAULT '[]',
      is_featured BOOLEAN DEFAULT false,
      cover_image TEXT DEFAULT ''
    );
    
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS show_in_menu BOOLEAN DEFAULT true;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS cover_image TEXT DEFAULT '';
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS menu_service_type VARCHAR(20) DEFAULT '';

    CREATE TABLE IF NOT EXISTS services (
      id          SERIAL PRIMARY KEY,
      category_id INT REFERENCES categories(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      price       NUMERIC(12,2) DEFAULT 0,
      image       TEXT DEFAULT 'default',
      packages    TEXT DEFAULT '[]',
      fields      TEXT DEFAULT '[]',
      price_type  VARCHAR(50) DEFAULT 'fixed',
      price_per_thousand NUMERIC(12,2) DEFAULT 0,
      fields_title VARCHAR(255),
      download_link TEXT DEFAULT '',
      download_link_title VARCHAR(255) DEFAULT '',
      show_in_menu BOOLEAN DEFAULT false,
      is_featured BOOLEAN DEFAULT false
    );
    
    ALTER TABLE services ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;

    CREATE TABLE IF NOT EXISTS orders (
      id             SERIAL PRIMARY KEY,
      service_id     INT,
      service_name   TEXT,
      category_name  VARCHAR(200),
      player_id      TEXT,
      phone          VARCHAR(100),
      package_name   TEXT,
      package_price  NUMERIC(12,2),
      customer_id    INT REFERENCES customers(id) ON DELETE SET NULL,
      payment_method VARCHAR(50) DEFAULT 'wallet',
      sender_phone   VARCHAR(100) DEFAULT '',
      transfer_to    VARCHAR(100) DEFAULT '',
      status         VARCHAR(30) DEFAULT 'pending',
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      quantity       INT DEFAULT 1,
      receipt_image  TEXT DEFAULT '',
      transfer_amount NUMERIC(12,2) DEFAULT 0,
      code           TEXT DEFAULT '',
      download_link  TEXT DEFAULT '',
      download_link_title VARCHAR(255) DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
      order_id INT REFERENCES orders(id) ON DELETE SET NULL,
      subject TEXT NOT NULL,
      details TEXT NOT NULL,
      status VARCHAR(30) DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS banners (
      id        SERIAL PRIMARY KEY,
      title     VARCHAR(300),
      highlight VARCHAR(300) DEFAULT '',
      description TEXT DEFAULT '',
      badge     VARCHAR(100) DEFAULT '',
      color     VARCHAR(30) DEFAULT '#8b5cf6',
      icon      TEXT DEFAULT '⚡',
      link      TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS wallet_requests (
      id                SERIAL PRIMARY KEY,
      customer_id       INT REFERENCES customers(id) ON DELETE CASCADE,
      customer_username VARCHAR(100),
      amount            NUMERIC(12,2),
      currency          VARCHAR(20) DEFAULT 'EGP',
      sender_phone      VARCHAR(100) DEFAULT '',
      notes             TEXT DEFAULT '',
      status            VARCHAR(30) DEFAULT 'pending',
      admin_note        TEXT DEFAULT '',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      processed_at      TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id                SERIAL PRIMARY KEY,
      customer_id       INT REFERENCES customers(id) ON DELETE CASCADE,
      customer_username VARCHAR(100),
      type              VARCHAR(20) DEFAULT 'debit',
      amount            NUMERIC(12,2),
      balance_before    NUMERIC(12,2),
      balance_after     NUMERIC(12,2),
      reference_type    VARCHAR(50) DEFAULT '',
      reference_id      INT,
      description       TEXT DEFAULT '',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_discounts (
      id                SERIAL PRIMARY KEY,
      customer_id       INT REFERENCES customers(id) ON DELETE CASCADE,
      discount_type     VARCHAR(30) DEFAULT 'percentage',
      discount_value    NUMERIC(12,2) DEFAULT 0,
      description       TEXT DEFAULT '',
      service_id        INT DEFAULT NULL,
      category_id       INT DEFAULT NULL,
      is_active         BOOLEAN DEFAULT true,
      expires_at        TIMESTAMPTZ DEFAULT NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS membership_tiers (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(100) NOT NULL,
      condition_type    VARCHAR(50) DEFAULT 'total_deposited',
      condition_value   NUMERIC(12,2) DEFAULT 0,
      icon              VARCHAR(50) DEFAULT '⭐',
      color             VARCHAR(50) DEFAULT '#fbbf24',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS membership_discounts (
      id                SERIAL PRIMARY KEY,
      tier_id           INT REFERENCES membership_tiers(id) ON DELETE CASCADE,
      target_type       VARCHAR(50) DEFAULT 'global',
      target_id         INT DEFAULT NULL,
      discount_type     VARCHAR(50) DEFAULT 'percentage',
      discount_value    NUMERIC(12,2) DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_memberships (
      id                SERIAL PRIMARY KEY,
      customer_id       INT REFERENCES customers(id) ON DELETE CASCADE,
      tier_id           INT REFERENCES membership_tiers(id) ON DELETE CASCADE,
      assigned_by       VARCHAR(100) DEFAULT 'admin',
      notes             TEXT DEFAULT '',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(customer_id, tier_id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(150) NOT NULL,
      review            TEXT NOT NULL,
      rating            INT DEFAULT 5,
      country_code      VARCHAR(10) DEFAULT 'EG',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_providers (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(100) NOT NULL,
      api_url           TEXT NOT NULL,
      username          VARCHAR(100) DEFAULT '',
      api_key           TEXT NOT NULL,
      balance           NUMERIC(12,2) DEFAULT 0,
      currency          VARCHAR(20) DEFAULT 'USD',
      is_active         BOOLEAN DEFAULT true,
      provider_type     VARCHAR(50) DEFAULT 'dhru',
      mapping_rules     TEXT DEFAULT NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_logs (
      id                SERIAL PRIMARY KEY,
      customer_id       INT REFERENCES customers(id) ON DELETE CASCADE,
      api_key           VARCHAR(100),
      endpoint          VARCHAR(255),
      request_body      TEXT,
      response_status   INT,
      ip_address        VARCHAR(100),
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_otps (
      otp_key           VARCHAR(100) PRIMARY KEY,
      data              TEXT NOT NULL,
      expires_at        BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversion_events (
      id                SERIAL PRIMARY KEY,
      event_name        VARCHAR(80) NOT NULL,
      session_id        VARCHAR(100) DEFAULT '',
      path              TEXT DEFAULT '',
      metadata          TEXT DEFAULT '{}',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_conversion_events_created_at
      ON conversion_events (created_at DESC);
  `);

  // Migration to add color and icon columns to existing categories table, and dynamic pricing to services/orders
  try {
    await pool.query(`
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) DEFAULT 'EG';
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS color VARCHAR(50) DEFAULT '#6366f1';
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon VARCHAR(100) DEFAULT 'credit-card';
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS currency VARCHAR(20) DEFAULT 'USD';
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS fields TEXT DEFAULT '[]';
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS fields_title VARCHAR(255) DEFAULT 'بيانات الخدمة';
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INT DEFAULT NULL;
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS linked_categories TEXT DEFAULT '[]';
      ALTER TABLE services ADD COLUMN IF NOT EXISTS price_type VARCHAR(50) DEFAULT 'fixed';
      ALTER TABLE services ADD COLUMN IF NOT EXISTS price_per_thousand NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS fields_title VARCHAR(255);
      ALTER TABLE services ADD COLUMN IF NOT EXISTS download_link TEXT DEFAULT '';
      ALTER TABLE services ADD COLUMN IF NOT EXISTS download_link_title VARCHAR(255) DEFAULT '';
      ALTER TABLE services ADD COLUMN IF NOT EXISTS api_service_id VARCHAR(100);
      ALTER TABLE services ADD COLUMN IF NOT EXISTS api_source VARCHAR(100);
      ALTER TABLE services ADD COLUMN IF NOT EXISTS api_price NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS show_in_menu BOOLEAN DEFAULT false;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN DEFAULT false;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS bundle_services TEXT DEFAULT '[]';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_image TEXT DEFAULT '';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS transfer_amount NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS code TEXT DEFAULT '';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS download_link TEXT DEFAULT '';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS download_link_title VARCHAR(255) DEFAULT '';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_order_id VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_source VARCHAR(100);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_status VARCHAR(255);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS custom_fields TEXT;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS min_quantity INT DEFAULT 100;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS max_quantity INT DEFAULT 0;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS is_popular BOOLEAN DEFAULT false;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS balances TEXT DEFAULT '{"USD":0,"USDT":0}';
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT '';
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_plain VARCHAR(255) DEFAULT '';
      ALTER TABLE wallet_requests ADD COLUMN IF NOT EXISTS currency VARCHAR(20) DEFAULT 'USD';
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_level VARCHAR(30) DEFAULT 'bronze';
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT false;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_orders INT DEFAULT 0;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_order_at TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS reset_otp VARCHAR(20) DEFAULT NULL;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS reset_otp_expires TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_deposited NUMERIC(12,2) DEFAULT 0;
      ALTER TABLE orders ALTER COLUMN phone TYPE VARCHAR(100);
      ALTER TABLE orders ALTER COLUMN sender_phone TYPE VARCHAR(100);
      ALTER TABLE wallet_requests ALTER COLUMN sender_phone TYPE VARCHAR(100);
      ALTER TABLE customers ALTER COLUMN phone TYPE VARCHAR(100);
      ALTER TABLE orders ALTER COLUMN api_status TYPE VARCHAR(255);
      ALTER TABLE orders ALTER COLUMN api_order_id TYPE VARCHAR(100);
      ALTER TABLE services ALTER COLUMN api_service_id TYPE VARCHAR(100);
      ALTER TABLE services ALTER COLUMN api_source TYPE VARCHAR(100);
      ALTER TABLE services ALTER COLUMN name TYPE TEXT;
      ALTER TABLE orders ALTER COLUMN service_name TYPE TEXT;
      ALTER TABLE orders ALTER COLUMN package_name TYPE TEXT;
      ALTER TABLE services ADD COLUMN IF NOT EXISTS api_provider_id INT REFERENCES api_providers(id) ON DELETE SET NULL;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_provider_id INT REFERENCES api_providers(id) ON DELETE SET NULL;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS api_key VARCHAR(100) UNIQUE DEFAULT NULL;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS api_enabled BOOLEAN DEFAULT false;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS api_requested BOOLEAN DEFAULT false;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS api_markup NUMERIC(5,2) DEFAULT 0;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS api_blocked_services TEXT DEFAULT '[]';
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS api_allowed_ips TEXT DEFAULT '[]';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_api_order BOOLEAN DEFAULT false;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS api_reseller_id INT REFERENCES customers(id) ON DELETE SET NULL;
      ALTER TABLE banners ADD COLUMN IF NOT EXISTS link TEXT DEFAULT '';
      ALTER TABLE api_providers ADD COLUMN IF NOT EXISTS provider_type VARCHAR(50) DEFAULT 'dhru';
      ALTER TABLE api_providers ADD COLUMN IF NOT EXISTS mapping_rules TEXT DEFAULT NULL;
    `);

    // Migration: rename old fields_title labels and fix default currency
    await pool.query(`
      UPDATE categories SET fields_title = 'بيانات الخدمة' WHERE fields_title = 'بيانات الحساب المراد شحنه';
      UPDATE services SET fields_title = 'بيانات الخدمة' WHERE fields_title = 'بيانات الحساب المراد شحنه';
      UPDATE categories SET currency = 'USD' WHERE currency = 'EGP';
    `);
    console.log('Migration: old labels and currency updated.');
  } catch (err) {
    console.error('Migration error adding table columns:', err.message);
  }

  // ── Isolated migration: api_delivery_time column ─────────
  try {
    await pool.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS api_delivery_time VARCHAR(255) DEFAULT '';`);
    console.log('Migration: api_delivery_time column ensured.');
  } catch (err) {
    console.error('Migration error adding api_delivery_time:', err.message);
  }

  // ── Isolated migration: api_service_type column (runs independently) ─────────
  try {
    await pool.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS api_service_type VARCHAR(20) DEFAULT 'imei';`);
    console.log('Migration: api_service_type column ensured.');
  } catch (err) {
    console.error('Migration error adding api_service_type:', err.message);
  }

  // ── Performance Indexes ─────────
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customers_api_key ON customers(api_key);
      CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
      CREATE INDEX IF NOT EXISTS idx_wallet_tx_customer_id ON wallet_transactions(customer_id);
      CREATE INDEX IF NOT EXISTS idx_api_logs_api_key ON api_logs(api_key);
    `);
    console.log('Migration: Performance indexes verified / created.');
  } catch (err) {
    console.error('Migration error adding indexes:', err.message);
  }

  console.log('PostgreSQL tables verified / created.');
}

// ──────────────────────────────────────────────────────────────────────────────
// SQL Query Adapters
// ──────────────────────────────────────────────────────────────────────────────
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const runQuery = async (sql, params = []) => {
  if (fallbackMode) {
    return executeJsonRunQuery(sql, params);
  }

  const pgSql = toPgParams(sql);
  try {
    const result = await pool.query(pgSql, params);
    if (result.rows && result.rows.length > 0 && result.rows[0].id !== undefined) {
      return { lastID: result.rows[0].id, changes: result.rowCount };
    }
    return { lastID: null, changes: result.rowCount };
  } catch (err) {
    if (err.code === '23505') {
      const error = new Error('UNIQUE constraint failed');
      error.message = 'UNIQUE constraint failed';
      throw error;
    }
    throw err;
  }
};

const allQuery = async (sql, params = []) => {
  await dbInitialized;
  if (fallbackMode) {
    return executeJsonAllQuery(sql, params);
  }
  const pgSql = toPgParams(sql);
  const result = await pool.query(pgSql, params);
  return result.rows;
};

const getQuery = async (sql, params = []) => {
  await dbInitialized;
  if (fallbackMode) {
    return executeJsonGetQuery(sql, params);
  }
  const pgSql = toPgParams(sql);
  const result = await pool.query(pgSql, params);
  return result.rows[0] || null;
};

const patchedRunQuery = async (sql, params = []) => {
  await dbInitialized;
  if (fallbackMode) {
    return executeJsonRunQuery(sql, params);
  }
  const trimmed = sql.trim().toUpperCase();
  let finalSql = sql;
  if (trimmed.startsWith('INSERT') && !trimmed.includes('RETURNING')) {
    // settings and customer_otps tables do not have an 'id' column — skip RETURNING id
    const isSettingsOrOtpInsert = /INSERT\s+INTO\s+(settings|customer_otps)/i.test(sql);
    if (!isSettingsOrOtpInsert) {
      finalSql = sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
    }
  }
  return runQuery(finalSql, params);
};


// ──────────────────────────────────────────────────────────────────────────────
async function seedData() {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const existingAdmin = await getQuery('SELECT * FROM users WHERE username = ?', [adminUser]);
  if (!existingAdmin) {
    const hashed = await bcrypt.hash(adminPass, 10);
    await patchedRunQuery('INSERT INTO users (username, password) VALUES (?, ?)', [adminUser, hashed]);
    console.log(`Admin seeded: ${adminUser}`);
  }

  // Seed settings in PostgreSQL
  const existingSettings = await allQuery('SELECT * FROM settings');
  if (existingSettings.length === 0) {
    await patchedRunQuery("INSERT INTO settings (key, value) VALUES (?, ?)", ['site_name', 'عرب تك سيرفر']);
    await patchedRunQuery("INSERT INTO settings (key, value) VALUES (?, ?)", ['site_logo', '/logo.jpg']);
    await patchedRunQuery("INSERT INTO settings (key, value) VALUES (?, ?)", ['site_favicon', '/favicon.png']);
    console.log('Default settings seeded in PostgreSQL');
  }

  // Load from database.json
  let dbData;
  try {
    const dbPath = path.join(__dirname, 'database.json');
    if (fs.existsSync(dbPath)) {
      dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load database.json for seeding:', err.message);
  }

  if (dbData) {
    console.log('Synchronizing PostgreSQL tables with database.json...');

    // 0. Seed Settings (only insert if not exists)
    if (dbData.settings && dbData.settings.length > 0) {
      for (const s of dbData.settings) {
        const existing = await getQuery('SELECT * FROM settings WHERE key = ?', [s.key]);
        if (!existing) {
          const safeVal = (s.value === null || s.value === undefined) ? '' : String(s.value);
          await patchedRunQuery('INSERT INTO settings (key, value) VALUES (?, ?)', [s.key, safeVal]);
        }
      }
      console.log(`Settings seeded: ${dbData.settings.length} settings.`);
    }

    // 1. Seed Banners (only if empty)
    const dbBannersCount = await allQuery('SELECT count(*) as cnt FROM banners');
    if (dbData.banners && dbData.banners.length > 0 && dbBannersCount[0]?.cnt == 0) {
      for (const b of dbData.banners) {
        const existing = await getQuery('SELECT * FROM banners WHERE id = ?', [b.id]);
        const bannerValues = [b.title, b.highlight, b.desc || b.description || '', b.badge || '', b.color || '#8b5cf6', b.icon || '⚡'];
        if (!existing) {
          await patchedRunQuery(
            'INSERT INTO banners (id, title, highlight, description, badge, color, icon) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [b.id, ...bannerValues]
          );
        }
      }
      try {
        await allQuery("SELECT setval(pg_get_serial_sequence('banners', 'id'), coalesce(max(id), 1)) FROM banners");
      } catch (err) {
        console.error('Failed to reset banners sequence:', err.message);
      }
      console.log(`Banners seeded: ${dbData.banners.length} banners.`);
    }

    // 2. Sync Categories (only if empty)
    const dbCategoriesCount = await allQuery('SELECT count(*) as cnt FROM categories');
    if (dbData.categories && dbData.categories.length > 0 && dbCategoriesCount[0]?.cnt == 0) {
      for (const c of dbData.categories) {
        try {
          const existing = await getQuery('SELECT * FROM categories WHERE id = ?', [c.id])
            || await getQuery('SELECT * FROM categories WHERE name = ?', [c.name]);
          const fieldsVal = typeof c.fields === 'string' ? c.fields : JSON.stringify(c.fields || []);
          if (!existing) {
            await patchedRunQuery(
              'INSERT INTO categories (id, name, image, color, icon, currency, fields, fields_title, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [c.id, c.name, c.image, c.color || '#6366f1', c.icon || 'credit-card', c.currency || 'USD', fieldsVal, c.fields_title || 'بيانات الخدمة', c.parent_id || null]
            );
          }
        } catch (err) {
          console.error(`Failed to seed category ${c.name || c.id}:`, err.message);
        }
      }

      // Reset sequence
      try {
        await allQuery("SELECT setval(pg_get_serial_sequence('categories', 'id'), coalesce(max(id), 1)) FROM categories");
      } catch (err) {
        console.error('Failed to reset categories sequence:', err.message);
      }
      console.log(`Categories seeded: ${dbData.categories.length} categories.`);
    }

    // 3. Seed Services (only if empty)
    const dbServicesCount = await allQuery('SELECT count(*) as cnt FROM services');
    if (dbData.services && dbData.services.length > 0 && dbServicesCount[0]?.cnt == 0) {
      const categoryMap = {};
      const categoryIdMap = new Set();
      try {
        const dbCats = await allQuery('SELECT id, name FROM categories');
        for (const dbCat of dbCats) {
          categoryMap[dbCat.name.toLowerCase()] = dbCat.id;
          categoryIdMap.add(Number(dbCat.id));
        }
      } catch (err) {
        console.error('Failed to build category map:', err.message);
      }

      for (const s of dbData.services) {
        try {
          const existing = await getQuery('SELECT * FROM services WHERE id = ?', [s.id]);
          if (!existing) {
            let actualCategoryId = s.category_id;
            const originalCategory = (dbData.categories || []).find(c => c.id === s.category_id);
            if (originalCategory && categoryMap[originalCategory.name.toLowerCase()]) {
              actualCategoryId = categoryMap[originalCategory.name.toLowerCase()];
            }

            // Ensure category exists in categories table to avoid foreign key constraint violations
            const catIdNum = Number(actualCategoryId);
            if (!categoryIdMap.has(catIdNum)) {
              const catName = originalCategory ? originalCategory.name : (catIdNum === 13 ? 'خدمات Apple و iCloud' : (catIdNum === 16 ? 'أدوات وتفعيلات السيرفر (Schematics & Tools)' : `قسم الخدمة #${catIdNum}`));
              const catFields = originalCategory ? (typeof originalCategory.fields === 'string' ? originalCategory.fields : JSON.stringify(originalCategory.fields || [])) : '[]';
              await patchedRunQuery(
                'INSERT INTO categories (id, name, image, color, icon, currency, fields, fields_title, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [catIdNum, catName, 'default', '#6366f1', 'credit-card', 'USD', catFields, 'بيانات الخدمة', null]
              );
              categoryIdMap.add(catIdNum);
              categoryMap[catName.toLowerCase()] = catIdNum;
            }

            const values = [
              actualCategoryId,
              s.name,
              s.description || '',
              s.price || 0,
              s.image || 'default',
              typeof s.packages === 'string' ? s.packages : JSON.stringify(s.packages || []),
              typeof s.fields === 'string' ? s.fields : JSON.stringify(s.fields || []),
              s.price_type || 'fixed',
              s.price_per_thousand || 0,
              s.fields_title || ''
            ];
            await patchedRunQuery(
              'INSERT INTO services (id, category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [s.id, ...values]
            );
          }
        } catch (err) {
          console.error(`Failed to seed service ${s.name || s.id}:`, err.message);
        }
      }
      // Reset sequence
      try {
        await allQuery("SELECT setval(pg_get_serial_sequence('services', 'id'), coalesce(max(id), 1)) FROM services");
      } catch (err) {
        console.error('Failed to reset services sequence:', err.message);
      }
      console.log(`Services seeded: ${dbData.services.length} services.`);
    }
  }

  // Seed email settings if missing
  const emailCredentials = [
    { key: 'email_user', value: 'arab.tech.services2@gmail.com' },
    { key: 'email_pass', value: 'ejow pcqv otls vayx' },
    { key: 'email_host', value: 'smtp.gmail.com' },
    { key: 'email_port', value: '465' }
  ];
  for (const cred of emailCredentials) {
    try {
      const existing = await getQuery('SELECT * FROM settings WHERE key = ?', [cred.key]);
      if (!existing) {
        await patchedRunQuery('INSERT INTO settings (key, value) VALUES (?, ?)', [cred.key, cred.value]);
      } else if (!existing.value || existing.value === '') {
        await patchedRunQuery('UPDATE settings SET value = ? WHERE key = ?', [cred.value, cred.key]);
      }
    } catch (e) {}
  }

  // ── Auto Cleanup names containing Amrr/Ameer ─────────────────────────────────
  try {
    const cats = await allQuery('SELECT id, name FROM categories');
    for (const c of cats) {
      try {
        let cleanName = c.name.replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim();
        if (!cleanName || cleanName === '') {
          cleanName = 'عام';
        }
        if (cleanName !== c.name) {
          const existingCat = await getQuery('SELECT id FROM categories WHERE name = ? AND id != ?', [cleanName, c.id]);
          if (existingCat) {
            await patchedRunQuery('UPDATE services SET category_id = ? WHERE category_id = ?', [existingCat.id, c.id]);
            await patchedRunQuery('DELETE FROM categories WHERE id = ?', [c.id]);
            console.log(`[Auto Clean] Merged category "${c.name}" (ID ${c.id}) into existing category "${cleanName}" (ID ${existingCat.id})`);
          } else {
            await patchedRunQuery('UPDATE categories SET name = ? WHERE id = ?', [cleanName, c.id]);
            console.log(`[Auto Clean] Category name updated: "${c.name}" -> "${cleanName}"`);
          }
        }
      } catch (errCat) {
        console.error(`[Auto Clean] Error cleaning category ID ${c.id}:`, errCat.message);
      }
    }

    const svcs = await allQuery('SELECT id, name, description, packages FROM services');
    for (const s of svcs) {
      try {
        let cleanName = s.name.replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim();
        if (!cleanName || cleanName === '') {
          cleanName = 'تفعيل فوري تلقائي';
        }
        const cleanDesc = (s.description || '').replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim();

        let cleanPackagesStr = s.packages;
        if (s.packages) {
          try {
            const pkgs = typeof s.packages === 'string' ? JSON.parse(s.packages) : s.packages;
            if (Array.isArray(pkgs)) {
              let changed = false;
              const cleanPkgs = pkgs.map(p => {
                let pCleanName = (p.name || '').replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim();
                if (!pCleanName || pCleanName === '') {
                  pCleanName = 'تفعيل فوري تلقائي';
                }
                if (pCleanName !== p.name) {
                  changed = true;
                  return { ...p, name: pCleanName };
                }
                return p;
              });
              if (changed) {
                cleanPackagesStr = JSON.stringify(cleanPkgs);
              }
            }
          } catch (e) {
            console.error('[Auto Clean] packages JSON parse error for service ID:', s.id, e.message);
          }
        }

        if (cleanName !== s.name || cleanDesc !== s.description || cleanPackagesStr !== s.packages) {
          await patchedRunQuery('UPDATE services SET name = ?, description = ?, packages = ? WHERE id = ?', [cleanName, cleanDesc, cleanPackagesStr, s.id]);
          console.log(`[Auto Clean] Service name updated: "${s.name}" -> "${cleanName}"`);
        }
      } catch (errSvc) {
        console.error(`[Auto Clean] Error cleaning service ID ${s.id}:`, errSvc.message);
      }
    }

    // Ultimate clean up of ALL player_id fields from ALL services and categories
    const allSvcs = await allQuery("SELECT id, fields, packages FROM services");
    for (const s of allSvcs) {
      try {
        let changed = false;
        let fieldsArr = typeof s.fields === 'string' ? JSON.parse(s.fields) : (s.fields || []);
        if (Array.isArray(fieldsArr)) {
          const withoutLegacyPlayerId = fieldsArr.filter(f => f.id !== 'player_id' && f.name !== 'player_id');
          const cleaned = removeLegacySerialDuplicate(withoutLegacyPlayerId);
          if (cleaned.length !== fieldsArr.length) {
            fieldsArr = cleaned;
            changed = true;
          }
        }
        let pkgsArr = typeof s.packages === 'string' ? JSON.parse(s.packages) : (s.packages || []);
        if (Array.isArray(pkgsArr)) {
          for (const p of pkgsArr) {
            if (Array.isArray(p.fields)) {
              const withoutLegacyPlayerId = p.fields.filter(f => f.id !== 'player_id' && f.name !== 'player_id');
              const pCleaned = removeLegacySerialDuplicate(withoutLegacyPlayerId);
              if (pCleaned.length !== p.fields.length) {
                p.fields = pCleaned;
                changed = true;
              }
            }
          }
        }
        if (changed) {
          await patchedRunQuery("UPDATE services SET fields = ?, packages = ? WHERE id = ?", [JSON.stringify(fieldsArr), JSON.stringify(pkgsArr), s.id]);
          console.log(`[Auto Clean] Wiped player_id from service ID #${s.id}`);
        }
      } catch (err) {}
    }
    const catsQuery = await allQuery("SELECT id, fields FROM categories");
    for (const c of catsQuery) {
      try {
        let fieldsArr = typeof c.fields === 'string' ? JSON.parse(c.fields) : (c.fields || []);
        if (Array.isArray(fieldsArr)) {
          const cleaned = fieldsArr.filter(f => f.id !== 'player_id' && f.name !== 'player_id');
          if (cleaned.length !== fieldsArr.length) {
            await patchedRunQuery("UPDATE categories SET fields = ? WHERE id = ?", [JSON.stringify(cleaned), c.id]);
          }
        }
      } catch(e){}
    }
  } catch (err) {
    console.error('[Auto Clean] Error cleaning Amrr/Ameer from database:', err.message);
  }

  // ── Auto Cleanup Duplicate Categories ──────────────────────────────────────
  try {
    const allCats = await allQuery('SELECT id, name FROM categories');
    const nameMap = {};
    for (const c of allCats) {
      const normalized = c.name.trim().toLowerCase();
      if (!nameMap[normalized]) nameMap[normalized] = [];
      nameMap[normalized].push(c.id);
    }
    
    for (const [name, ids] of Object.entries(nameMap)) {
      if (ids.length > 1) {
        // Sort IDs, keep the smallest one
        ids.sort((a, b) => a - b);
        const keepId = ids[0];
        const removeIds = ids.slice(1);
        
        // Update services pointing to removeIds to point to keepId
        for (const rId of removeIds) {
          await patchedRunQuery('UPDATE services SET category_id = ? WHERE category_id = ?', [keepId, rId]);
          await patchedRunQuery('DELETE FROM categories WHERE id = ?', [rId]);
        }
        console.log(`[Auto Clean] Merged duplicate categories for "${name}". Kept ID: ${keepId}, Removed: ${removeIds.join(', ')}`);
      }
    }
  } catch (err) {
    console.error('[Auto Clean] Error cleaning duplicate categories:', err.message);
  }

  // ── Auto Force Currency to USD ──────────────────────────────────────────
  try {
    // Force base_currency to USD
    const exists = await getQuery("SELECT * FROM settings WHERE key = 'base_currency'");
    if (!exists) {
      await patchedRunQuery("INSERT INTO settings (key, value) VALUES (?, ?)", ['base_currency', 'USD']);
    } else {
      await patchedRunQuery("UPDATE settings SET value = ? WHERE key = ?", ['USD', 'base_currency']);
    }

    // Force currencies list to ["USD"]
    const currRow = await getQuery("SELECT * FROM settings WHERE key = 'currencies'");
    if (!currRow) {
      await patchedRunQuery("INSERT INTO settings (key, value) VALUES (?, ?)", ['currencies', JSON.stringify(["USD"])]);
    } else {
      await patchedRunQuery("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(["USD"]), 'currencies']);
    }

    // Force exchange rates to {"USD":1}
    const ratesRow = await getQuery("SELECT * FROM settings WHERE key = 'exchange_rates'");
    if (!ratesRow) {
      await patchedRunQuery("INSERT INTO settings (key, value) VALUES (?, ?)", ['exchange_rates', JSON.stringify({ "USD": 1 })]);
    } else {
      await patchedRunQuery("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify({ "USD": 1 }), 'exchange_rates']);
    }

    // Fix categories and wallet currency
    await patchedRunQuery("UPDATE categories SET currency = ?", ['USD']);
    await patchedRunQuery("UPDATE wallet_requests SET currency = ?", ['USD']);

    // Migrate customer balances from USDT to USD
    const allCustomers = await allQuery("SELECT id, balances FROM customers");
    for (const cust of allCustomers) {
      try {
        let bal = typeof cust.balances === 'string' ? JSON.parse(cust.balances) : (cust.balances || {});
        let changed = false;
        // If has USDT but no USD, move USDT to USD
        if (bal.USDT !== undefined && bal.USD === undefined) {
          bal.USD = bal.USDT;
          delete bal.USDT;
          changed = true;
        }
        // If has USDT and USD, merge USDT into USD
        if (bal.USDT !== undefined && bal.USD !== undefined) {
          bal.USD = (Number(bal.USD) || 0) + (Number(bal.USDT) || 0);
          delete bal.USDT;
          changed = true;
        }
        // Remove EGP if exists
        if (bal.EGP !== undefined) {
          delete bal.EGP;
          changed = true;
        }
        // Ensure USD key exists
        if (bal.USD === undefined) {
          bal.USD = 0;
          changed = true;
        }
        if (changed) {
          await patchedRunQuery("UPDATE customers SET balances = ? WHERE id = ?", [JSON.stringify(bal), cust.id]);
        }
      } catch (e) { /* skip parse errors */ }
    }

    console.log('[Currency Sync] All currencies forced to USD globally.');
  } catch (err) {
    console.error('[Currency Sync] Error forcing USD currency:', err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Automatic Background Image Cleanup (base64 to files)
// ──────────────────────────────────────────────────────────────────────────────
async function runAutomaticCleanup() {
  try {
    const { saveImage } = require('./utils/imageSaver');

    // 1. Categories
    const categories = await allQuery('SELECT * FROM categories');
    for (const cat of categories) {
      if (cat.image && cat.image.startsWith('data:image')) {
        const fileUrl = saveImage(cat.image);
        if (fileUrl && fileUrl.startsWith('/uploads')) {
          await patchedRunQuery('UPDATE categories SET image = ? WHERE id = ?', [fileUrl, cat.id]);
          console.log(`[Auto Cleanup] Category ID ${cat.id} image migrated to file.`);
        }
      }
    }

    // 2. Services
    const services = await allQuery('SELECT * FROM services');
    for (const service of services) {
      if (service.image && service.image.startsWith('data:image')) {
        const fileUrl = saveImage(service.image);
        if (fileUrl && fileUrl.startsWith('/uploads')) {
          await patchedRunQuery('UPDATE services SET image = ? WHERE id = ?', [fileUrl, service.id]);
          console.log(`[Auto Cleanup] Service ID ${service.id} image migrated to file.`);
        }
      }
    }

    // 3. Banners
    const banners = await allQuery('SELECT * FROM banners');
    for (const banner of banners) {
      if (banner.icon && banner.icon.startsWith('data:image')) {
        const fileUrl = saveImage(banner.icon);
        if (fileUrl && fileUrl.startsWith('/uploads')) {
          await patchedRunQuery('UPDATE banners SET icon = ? WHERE id = ?', [fileUrl, banner.id]);
          console.log(`[Auto Cleanup] Banner ID ${banner.id} icon migrated to file.`);
        }
      }
    }

    // 4. Settings
    const settings = await allQuery('SELECT * FROM settings WHERE key IN (\'site_logo\', \'site_favicon\')');
    for (const setting of settings) {
      if (setting.value && setting.value.startsWith('data:image')) {
        const fileUrl = saveImage(setting.value);
        if (fileUrl && fileUrl.startsWith('/uploads')) {
          await patchedRunQuery('UPDATE settings SET value = ? WHERE key = ?', [fileUrl, setting.key]);
          console.log(`[Auto Cleanup] Setting ${setting.key} migrated to file.`);
        }
      }
    }

    // 5. database.json
    const dbPath = path.join(__dirname, 'database.json');
    if (fs.existsSync(dbPath)) {
      try {
        const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        let dbChanged = false;
        if (dbData.categories) {
          for (const cat of dbData.categories) {
            if (cat.image && cat.image.startsWith('data:image')) {
              const fileUrl = saveImage(cat.image);
              if (fileUrl && fileUrl.startsWith('/uploads')) { cat.image = fileUrl; dbChanged = true; }
            }
          }
        }
        if (dbData.services) {
          for (const service of dbData.services) {
            if (service.image && service.image.startsWith('data:image')) {
              const fileUrl = saveImage(service.image);
              if (fileUrl && fileUrl.startsWith('/uploads')) { service.image = fileUrl; dbChanged = true; }
            }
          }
        }
        if (dbData.banners) {
          for (const banner of dbData.banners) {
            if (banner.icon && banner.icon.startsWith('data:image')) {
              const fileUrl = saveImage(banner.icon);
              if (fileUrl && fileUrl.startsWith('/uploads')) { banner.icon = fileUrl; dbChanged = true; }
            }
          }
        }
        if (dbData.settings) {
          for (const setting of dbData.settings) {
            if ((setting.key === 'site_logo' || setting.key === 'site_favicon') && setting.value && setting.value.startsWith('data:image')) {
              const fileUrl = saveImage(setting.value);
              if (fileUrl && fileUrl.startsWith('/uploads')) { setting.value = fileUrl; dbChanged = true; }
            }
          }
        }
        if (dbChanged) {
          fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');
          console.log('[Auto Cleanup] database.json cleaned up.');
        }
      } catch (err) {
        // Ignore
      }
    }
  } catch (error) {
    console.error('[Auto Cleanup] Background image migration error:', error.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────────
async function initializeDatabase() {
  if (process.env.USE_LOCAL_JSON_DB === 'true' || fallbackMode) {
    console.log('⚡ [Local Mode] USE_LOCAL_JSON_DB enabled. Running database locally via JSON fallback.');
    setFallbackMode(true, 'local-mode');
    const db = readDb();
    let jsonUpdated = false;
    if (db.customers) {
      db.customers = db.customers.map(c => {
        if (!c.balances || c.balances === '{}' || c.balances === '' || Object.keys(c.balances).length === 0) {
          c.balances = { "USD": 0, "USDT": 0 };
          jsonUpdated = true;
        }
        if (c.email === undefined) {
          c.email = '';
          jsonUpdated = true;
        }
        return c;
      });
    }
    if (db.categories) {
      db.categories = db.categories.map(cat => {
        if (!cat.currency || cat.currency !== 'USD') {
          cat.currency = 'USD';
          jsonUpdated = true;
        }
        if (cat.fields_title === undefined) {
          cat.fields_title = 'بيانات الخدمة';
          jsonUpdated = true;
        }
        return cat;
      });
    }
    if (db.services) {
      db.services = db.services.map(s => {
        if (s.fields_title === undefined) {
          s.fields_title = '';
          jsonUpdated = true;
        }
        return s;
      });
    }
    if (jsonUpdated) {
      writeDb(db);
      console.log('Synchronized JSON database customers and categories with default attributes.');
    }
    if (dbInitializedResolve) {
      dbInitializedResolve();
    }
    seedData().catch(err => console.error('Background seeding error:', err.message));
    runAutomaticCleanup().catch(err => console.error('Automatic cleanup error:', err.message));
    return;
  }

  try {
    // Try to connect with retry loop (handles initial container startup latency)
    let connected = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const client = await pool.connect();
        client.release();
        connected = true;
        console.log(`PostgreSQL connection established successfully on attempt ${attempt}.`);
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[PostgreSQL] Connection attempt ${attempt}/4 failed: ${e.message}. Retrying in 2.5s...`);
        if (attempt < 4) await new Promise(r => setTimeout(r, 2500));
      }
    }
    if (!connected) {
      throw lastErr || new Error('Failed to connect to PostgreSQL after 4 attempts');
    }
    await createTables();

    // PostgreSQL Migration to initialize existing rows with default currencies
    try {
      await pool.query(`UPDATE customers SET balances = '{"USD":0,"USDT":0}' WHERE balances IS NULL OR balances = '{}' OR balances = '' OR balances = '[]';`);
      console.log('PostgreSQL customer balances migrated successfully.');
    } catch (err) {
      console.error('Failed to run migration update for existing customer balances:', err.message);
    }

    // Migration: Strip "Amrr"/"Ammr" from service and package names (do not delete)
    try {
      // Update service names
      const nameResult = await pool.query(
        `UPDATE services SET name = TRIM(REGEXP_REPLACE(REGEXP_REPLACE(name, '(?i)amrr\\s*', '', 'g'), '(?i)ammr\\s*', '', 'g')) WHERE LOWER(name) LIKE '%amrr%' OR LOWER(name) LIKE '%ammr%'`
      );
      if (nameResult.rowCount > 0) {
        console.log(`Migration: Stripped Amrr/Ammr from ${nameResult.rowCount} service name(s).`);
      }
    } catch (err) {
      console.error('Failed to strip Amrr/Ammr from service names:', err.message);
    }

    // ✅ Resolve dbInitialized BEFORE seeding so API requests aren't blocked
    if (dbInitializedResolve) {
      dbInitializedResolve();
    }

    // Run seeding in background — won't block incoming requests
    seedData().catch(err => console.error('Background seeding error:', err.message));

    // Run automatic background images cleanup
    runAutomaticCleanup().catch(err => console.error('Automatic cleanup error:', err.message));

  } catch (err) {
    console.log('Could not connect to PostgreSQL. Falling back to JSON database.');
    setFallbackMode(true, err.message);
    const db = readDb();
    let jsonUpdated = false;
    if (db.customers) {
      db.customers = db.customers.map(c => {
        if (!c.balances || c.balances === '{}' || c.balances === '' || Object.keys(c.balances).length === 0) {
          c.balances = { "USD": 0, "USDT": 0 };
          jsonUpdated = true;
        }
        if (c.email === undefined) {
          c.email = '';
          jsonUpdated = true;
        }
        return c;
      });
    }
    if (db.categories) {
      db.categories = db.categories.map(cat => {
        if (!cat.currency || cat.currency !== 'USD') {
          cat.currency = 'USD';
          jsonUpdated = true;
        }
        if (cat.fields_title === undefined) {
          cat.fields_title = 'بيانات الخدمة';
          jsonUpdated = true;
        }
        return cat;
      });
    }
    if (db.services) {
      db.services = db.services.map(s => {
        if (s.fields_title === undefined) {
          s.fields_title = '';
          jsonUpdated = true;
        }
        return s;
      });
    }
    if (jsonUpdated) {
      writeDb(db);
      console.log('Synchronized JSON database customers and categories with default attributes.');
    }
    // Still resolve so requests can proceed in fallback mode
    if (dbInitializedResolve) {
      dbInitializedResolve();
    }

    // Run seeding in background fallback JSON mode
    seedData().catch(err => console.error('Background seeding error:', err.message));

    // Run automatic background images cleanup in fallback JSON mode
    runAutomaticCleanup().catch(err => console.error('Automatic cleanup error:', err.message));
  }
}


initializeDatabase();

module.exports = {
  db: pool,
  runQuery: patchedRunQuery,
  allQuery,
  getQuery,
  seedData,
  readDb,
  writeDb,
  getDatabaseMode: () => ({ fallbackMode }),
  onDatabaseAlert: (handler) => dbEvents.on('database-alert', handler),
  onDatabaseModeChange: (handler) => dbEvents.on('database-mode-change', handler),
};

