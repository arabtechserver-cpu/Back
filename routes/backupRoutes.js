const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const deleteOtpAuth = require('../middleware/deleteOtpAuth');
const { allQuery, getDatabaseMode, runQuery } = require('../db');
const { writeBackupSnapshot, sendBackupViaWhatsApp, sendBackupViaTelegram, getBackupTableNames } = require('../utils/databaseBackup');

const BACKUP_ROOT = path.join(__dirname, '..', 'backups');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// Ensure backups directories exist
[BACKUP_ROOT, path.join(BACKUP_ROOT, 'database'), path.join(BACKUP_ROOT, 'fallback')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function findBackupFilePath(filename) {
  const safeFilename = path.basename(filename);
  if (!safeFilename.endsWith('.json')) return null;
  const paths = [
    path.join(BACKUP_ROOT, safeFilename),
    path.join(BACKUP_ROOT, 'database', safeFilename),
    path.join(BACKUP_ROOT, 'fallback', safeFilename)
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 1. Get all backups saved on the server (across root, database, and fallback dirs)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const dirs = [BACKUP_ROOT, path.join(BACKUP_ROOT, 'database'), path.join(BACKUP_ROOT, 'fallback')];
    const backups = [];
    
    dirs.forEach(dir => {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          if (file.endsWith('.json')) {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            backups.push({
              filename: file,
              size: stats.size,
              createdAt: stats.mtime
            });
          }
        });
      }
    });

    backups.sort((a, b) => b.createdAt - a.createdAt);
    res.json(backups);
  } catch (error) {
    console.error('List backups error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب قائمة النسخ الاحتياطية.' });
  }
});

// 2. Trigger a new manual backup
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const mode = getDatabaseMode();
    const tables = {};

    const tableNames = await getBackupTableNames(mode);

    if (mode.fallbackMode) {
      const dbPath = path.join(__dirname, '..', 'database.json');
      if (fs.existsSync(dbPath)) {
        const { readDb } = require('../db');
        const dbData = readDb();
        tableNames.forEach(table => {
          tables[table] = dbData[table] || [];
        });
      } else {
        tableNames.forEach(table => {
          tables[table] = [];
        });
      }
    } else {
      for (const table of tableNames) {
        try {
          tables[table] = table === 'settings'
            ? await allQuery('SELECT * FROM settings')
            : await allQuery(`SELECT * FROM ${table} ORDER BY id ASC`);
        } catch (error) {
          console.error(`Backup table ${table} error:`, error.message);
          tables[table] = [];
        }
      }
    }

    // Retrieve uploaded files (images, receipts, etc) recursively and encode them to Base64
    const uploads = {};
    
    function getFilesRecursively(dir) {
      let results = [];
      if (!fs.existsSync(dir)) return results;
      const list = fs.readdirSync(dir);
      list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          results = results.concat(getFilesRecursively(fullPath));
        } else {
          results.push(fullPath);
        }
      });
      return results;
    }

    if (fs.existsSync(UPLOADS_DIR)) {
      const files = getFilesRecursively(UPLOADS_DIR);
      files.forEach(filePath => {
        try {
          const relativePath = path.relative(UPLOADS_DIR, filePath).replace(/\\/g, '/');
          const fileData = fs.readFileSync(filePath);
          uploads[relativePath] = fileData.toString('base64');
        } catch (e) {
          console.error(`Failed to read upload file ${filePath}:`, e);
        }
      });
    }

    const backupSnapshot = {
      created_at: new Date().toISOString(),
      fallbackMode: mode.fallbackMode,
      tables,
      uploads
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-${timestamp}.json`;
    const backupPath = path.join(BACKUP_ROOT, fileName);

    fs.writeFileSync(backupPath, JSON.stringify(backupSnapshot, null, 2));
    
    await Promise.all([
      sendBackupViaWhatsApp(backupPath, 'manual'),
      sendBackupViaTelegram(backupPath, 'manual'),
    ]);

    res.json({
      message: 'تم إنشاء النسخة الاحتياطية بنجاح وإرسالها إلى الأدمن عبر تيليجرام وواتساب.',
      filename: fileName,
      createdAt: new Date()
    });
  } catch (error) {
    console.error('Create backup error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إنشاء النسخة الاحتياطية.' });
  }
});

// 2b. Trigger a FULL manual backup (including services, categories, packages, fields, api_providers)
router.post('/create-full', authMiddleware, async (req, res) => {
  try {
    const mode = getDatabaseMode();
    const tables = {};

    // Retrieve database tables (include EVERYTHING)
    const tableNames = await getBackupTableNames(mode, true);

    if (mode.fallbackMode) {
      const dbPath = path.join(__dirname, '..', 'database.json');
      if (fs.existsSync(dbPath)) {
        const { readDb } = require('../db');
        const dbData = readDb();
        tableNames.forEach(table => {
          tables[table] = dbData[table] || [];
        });
      } else {
        tableNames.forEach(table => {
          tables[table] = [];
        });
      }
    } else {
      for (const table of tableNames) {
        try {
          tables[table] = table === 'settings'
            ? await allQuery('SELECT * FROM settings')
            : await allQuery(`SELECT * FROM "${table}" ORDER BY id ASC`);
        } catch (error) {
          console.error(`Backup full table ${table} error:`, error.message);
          tables[table] = [];
        }
      }
    }

    // Retrieve uploaded files recursively and encode them to Base64
    const uploads = {};
    function getFilesRecursively(dir) {
      let results = [];
      if (!fs.existsSync(dir)) return results;
      const list = fs.readdirSync(dir);
      list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          results = results.concat(getFilesRecursively(fullPath));
        } else {
          results.push(fullPath);
        }
      });
      return results;
    }

    if (fs.existsSync(UPLOADS_DIR)) {
      const files = getFilesRecursively(UPLOADS_DIR);
      files.forEach(filePath => {
        try {
          const relativePath = path.relative(UPLOADS_DIR, filePath).replace(/\\/g, '/');
          const fileData = fs.readFileSync(filePath);
          uploads[relativePath] = fileData.toString('base64');
        } catch (e) {
          console.error(`Failed to read upload file ${filePath}:`, e);
        }
      });
    }

    const backupSnapshot = {
      isFullBackup: true,
      created_at: new Date().toISOString(),
      fallbackMode: mode.fallbackMode,
      tables,
      uploads
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `full-backup-${timestamp}.json`;
    const backupPath = path.join(BACKUP_ROOT, fileName);

    fs.writeFileSync(backupPath, JSON.stringify(backupSnapshot, null, 2));
    
    // Send the backup file to administrators on configured channels
    await Promise.all([
      sendBackupViaWhatsApp(backupPath, 'manual-full'),
      sendBackupViaTelegram(backupPath, 'manual-full'),
    ]);

    res.json({
      message: 'تم إنشاء النسخة الاحتياطية الشاملة (بما فيها الخدمات والباقات والحقول) بنجاح وحفظها وإرسالها للأدمن.',
      filename: fileName,
      createdAt: new Date()
    });
  } catch (error) {
    console.error('Create full backup error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إنشاء النسخة الاحتياطية الشاملة.' });
  }
});

// Direct Export & Download Full Backup JSON
router.get(['/export-full-download', '/download-full'], async (req, res) => {
  try {
    const token = req.query.token || (req.headers['authorization'] ? req.headers['authorization'].split(' ')[1] : null);
    if (!token) {
      return res.status(401).json({ message: 'رمز التوثيق غير موجود.' });
    }

    const jwt = require('jsonwebtoken');
    const { getJwtSecret } = require('../utils/security');
    const decoded = jwt.verify(token, getJwtSecret());
    if (!decoded) {
      return res.status(403).json({ message: 'رمز التوثيق غير صالح.' });
    }

    const mode = getDatabaseMode();
    const tables = {};

    const tableNames = await getBackupTableNames(mode, true);

    if (mode.fallbackMode) {
      const { readDb } = require('../db');
      const dbData = readDb();
      tableNames.forEach(table => {
        tables[table] = dbData[table] || [];
      });
    } else {
      for (const table of tableNames) {
        try {
          tables[table] = table === 'settings'
            ? await allQuery('SELECT * FROM settings')
            : await allQuery(`SELECT * FROM "${table}" ORDER BY id ASC`);
        } catch (error) {
          console.error(`Export full backup table ${table} error:`, error.message);
          tables[table] = [];
        }
      }
    }

    const uploads = {};
    if (fs.existsSync(UPLOADS_DIR)) {
      function getFilesRecursively(dir) {
        let results = [];
        if (!fs.existsSync(dir)) return results;
        const list = fs.readdirSync(dir);
        list.forEach(file => {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat && stat.isDirectory()) {
            results = results.concat(getFilesRecursively(fullPath));
          } else {
            results.push(fullPath);
          }
        });
        return results;
      }
      const files = getFilesRecursively(UPLOADS_DIR);
      files.forEach(filePath => {
        try {
          const relativePath = path.relative(UPLOADS_DIR, filePath).replace(/\\/g, '/');
          const fileData = fs.readFileSync(filePath);
          uploads[relativePath] = fileData.toString('base64');
        } catch (e) {
          console.error(`Failed to read upload file ${filePath}:`, e);
        }
      });
    }

    const fullBackupSnapshot = {
      isFullBackup: true,
      created_at: new Date().toISOString(),
      fallbackMode: mode.fallbackMode,
      tables,
      uploads
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `full-database-${timestamp}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(fullBackupSnapshot, null, 2));

  } catch (error) {
    console.error('Export full backup download error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تصدير ملف النسخة الاحتياطية الشاملة.' });
  }
});

// Send the newest saved backup to all configured Telegram administrators.
router.post('/send-latest-telegram', authMiddleware, async (req, res) => {
  try {
    const dirs = [BACKUP_ROOT, path.join(BACKUP_ROOT, 'database'), path.join(BACKUP_ROOT, 'fallback')];
    const files = dirs.flatMap(dir => fs.existsSync(dir)
      ? fs.readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => ({ path: path.join(dir, name), name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      : []
    ).sort((a, b) => b.time - a.time);

    // Deployment storage can be ephemeral. Create a fresh unsent snapshot when no file survived a restart.
    const latest = files[0] || null;
    let latestPath = latest?.path;
    let latestName = latest?.name;
    if (!latestPath) {
      latestPath = await writeBackupSnapshot('startup');
      latestName = path.basename(latestPath);
    }
    const result = await sendBackupViaTelegram(latestPath, 'manual');
    if (!result.total) return res.status(400).json({ message: 'لا يوجد معرف أدمن تيليجرام مسجل في الإعدادات.' });
    if (!result.sent) return res.status(502).json({ message: 'تعذر إرسال النسخة إلى تيليجرام. راجع إعدادات البوت وسجلات السيرفر.' });

    res.json({
      message: `تم إرسال أحدث نسخة إلى ${result.sent} من ${result.total} أدمن على تيليجرام.`,
      filename: latestName,
    });
  } catch (error) {
    console.error('Send latest backup to Telegram error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إرسال أحدث نسخة إلى تيليجرام.' });
  }
});

// 3. Download a backup file
router.get('/download/:filename', (req, res) => {
  try {
    const token = req.query.token || (req.headers['authorization'] ? req.headers['authorization'].split(' ')[1] : null);
    if (!token) {
      return res.status(401).json({ message: 'رمز التوثيق غير موجود.' });
    }

    const jwt = require('jsonwebtoken');
    const { getJwtSecret } = require('../utils/security');
    const decoded = jwt.verify(token, getJwtSecret());

    const { filename } = req.params;
    const safeFilename = path.basename(filename);
    const filePath = findBackupFilePath(safeFilename);

    if (!filePath) {
      return res.status(404).json({ message: 'الملف غير موجود.' });
    }

    res.download(filePath, safeFilename);
  } catch (error) {
    console.error('Download auth error:', error);
    return res.status(403).json({ message: 'رمز التوثيق غير صالح أو منتهي الصلاحية.' });
  }
});

// 4. Delete a backup file
router.delete('/:filename', authMiddleware, deleteOtpAuth, (req, res) => {
  const { filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = findBackupFilePath(safeFilename);

  if (!filePath) {
    return res.status(404).json({ message: 'الملف غير موجود.' });
  }

  try {
    fs.unlinkSync(filePath);
    res.json({ message: 'تم حذف ملف النسخة الاحتياطية بنجاح.' });
  } catch (error) {
    console.error('Delete backup error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف الملف.' });
  }
});

// Helper function to restore backup snapshot
async function restoreSnapshot(backupData) {
  const mode = getDatabaseMode();
  
  // 1. Restore Uploaded Files (creating parent directories if needed)
  if (backupData.uploads && typeof backupData.uploads === 'object') {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    Object.keys(backupData.uploads).forEach(fileName => {
      const fileContentBase64 = backupData.uploads[fileName];
      const filePath = path.join(UPLOADS_DIR, fileName);
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const buffer = Buffer.from(fileContentBase64, 'base64');
        fs.writeFileSync(filePath, buffer);
      } catch (err) {
        console.error(`Failed to restore file ${fileName}:`, err.message);
      }
    });
  }

  const tables = backupData.tables;
  if (!tables || typeof tables !== 'object') {
    throw new Error('بيانات النسخ الاحتياطي غير صالحة. لا تحتوي على جداول.');
  }

  const isFullBackup = Boolean(backupData.isFullBackup || tables.categories || tables.services || tables.api_providers);

  if (mode.fallbackMode) {
    // 2a. Fallback Mode - restore data
    const dbPath = path.join(__dirname, '..', 'database.json');
    const { readDb } = require('../db');
    const newDb = readDb();
    Object.keys(tables).forEach(table => {
      if (isFullBackup || (table !== 'categories' && table !== 'services')) {
        newDb[table] = tables[table] || [];
      }
    });
    
    const tmpPath = `${dbPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(newDb, null, 2));
    fs.renameSync(tmpPath, dbPath);
  } else {
    // 2b. PostgreSQL Mode - Run a transaction
    const { db } = require('../db');
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      const allPossibleTables = [
        'customer_otps',
        'api_logs',
        'reviews',
        'user_memberships',
        'membership_discounts',
        'membership_tiers',
        'customer_discounts', 
        'wallet_transactions', 
        'wallet_requests', 
        'orders', 
        'user_passkeys',
        'customers', 
        'banners', 
        'settings', 
        'users'
      ];
      if (isFullBackup) {
        allPossibleTables.unshift('services', 'categories', 'api_providers');
      }

      const tablesToTruncate = allPossibleTables.filter(t => tables[t] !== undefined || !isFullBackup);

      if (tablesToTruncate.length > 0) {
        await client.query(`
          TRUNCATE TABLE ${tablesToTruncate.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;
        `);
      }

      const tableNamesOrder = [
        'users', 'settings', 'api_providers', 'categories', 'services', 'customers', 'membership_tiers',
        'user_passkeys', 'banners', 'reviews',
        'customer_discounts', 'membership_discounts', 'user_memberships',
        'api_logs', 'customer_otps', 'wallet_requests', 'wallet_transactions',
        'orders'
      ];

      for (const tableName of tableNamesOrder) {
        const rows = tables[tableName];
        if (!rows || !Array.isArray(rows) || rows.length === 0) continue;

        // Fetch valid columns for this table in PostgreSQL public schema
        const colsRes = await client.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = $1
        `, [tableName]);
        
        const validColumns = new Set(colsRes.rows.map(r => r.column_name));

        // Insert row by row
        for (const row of rows) {
          // Filter row keys to only valid columns
          const filteredRow = {};
          Object.keys(row).forEach(key => {
            if (validColumns.has(key)) {
              filteredRow[key] = row[key];
            }
          });

          const keys = Object.keys(filteredRow);
          if (keys.length === 0) continue;

          const values = Object.values(filteredRow).map(val => {
            if (val !== null && typeof val === 'object') {
              return JSON.stringify(val);
            }
            return val;
          });

          const colsStr = keys.map(k => `"${k}"`).join(', ');
          const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(', ');
          
          await client.query(`INSERT INTO "${tableName}" (${colsStr}) VALUES (${placeholders})`, values);
        }

        // Reset sequence for all tables except settings
        if (tableName !== 'settings') {
          const seqRes = await client.query(`SELECT max(id) as max_id FROM "${tableName}"`);
          const maxId = seqRes.rows[0].max_id || 1;
          const checkSeq = await client.query(`
            SELECT pg_get_serial_sequence($1, 'id') as seq_name
          `, [tableName]);
          
          if (checkSeq.rows[0] && checkSeq.rows[0].seq_name) {
            await client.query(`SELECT setval($1, $2)`, [checkSeq.rows[0].seq_name, maxId]);
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// 5. Restore a backup from a saved server file
router.post('/restore/file', authMiddleware, async (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ message: 'اسم الملف مطلوب.' });
  }

  const safeFilename = path.basename(filename);
  const filePath = findBackupFilePath(safeFilename);

  if (!filePath) {
    return res.status(404).json({ message: 'الملف غير موجود.' });
  }

  try {
    const backupContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    await restoreSnapshot(backupContent);
    res.json({ message: 'تم استرجاع النسخة الاحتياطية بنجاح!' });
  } catch (error) {
    console.error('Restore backup from file error:', error);
    res.status(500).json({ message: `فشل استرجاع النسخة الاحتياطية: ${error.message}` });
  }
});

// 6. Restore a backup by uploading JSON directly
router.post('/restore/upload', authMiddleware, async (req, res) => {
  try {
    const { backupData } = req.body;
    if (!backupData || !backupData.tables) {
      return res.status(400).json({ message: 'بيانات النسخة الاحتياطية غير صالحة.' });
    }

    await restoreSnapshot(backupData);
    res.json({ message: 'تم استرجاع النسخة الاحتياطية بنجاح!' });
  } catch (error) {
    console.error('Restore backup from upload error:', error);
    res.status(500).json({ message: `فشل استرجاع النسخة الاحتياطية: ${error.message}` });
  }
});

module.exports = router;
