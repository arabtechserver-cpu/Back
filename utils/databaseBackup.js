const fs = require('fs');
const path = require('path');
const { allQuery, getDatabaseMode, onDatabaseAlert, onDatabaseModeChange } = require('../db');
const wa = require('../whatsapp');

const BACKUP_ROOT = path.join(__dirname, '..', 'backups');
const BACKUP_DIR = path.join(BACKUP_ROOT, 'database');
const FALLBACK_COPY_DIR = path.join(BACKUP_ROOT, 'fallback');
const BACKUP_INTERVAL_MS = Number(process.env.DB_BACKUP_INTERVAL_MS) || 5 * 60 * 60 * 1000; // 5 hours
const BACKUP_START_DELAY_MS = Number(process.env.DB_BACKUP_START_DELAY_MS) || 60 * 1000;

let schedulerStarted = false;
let lastAlertSignature = '';
let alertCooldownUntil = 0;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function readSettingsMap() {
  try {
    const rows = await allQuery('SELECT * FROM settings');
    const settings = {};
    rows.forEach((row) => {
      settings[row.key] = row.value;
    });
    return settings;
  } catch (error) {
    return {};
  }
}

async function sendBackupViaWhatsApp(backupPath, reason = 'scheduled') {
  try {
    if (wa.getStatus() !== 'ready') {
      console.warn('[DB Backup] WhatsApp not ready. Skipping WhatsApp document transmission.');
      return;
    }

    const settings = await readSettingsMap();
    let numbers = [];
    
    ['whatsapp_numbers', 'whatsapp_otp_numbers'].forEach(key => {
      if (settings[key]) {
        try {
          const parsed = JSON.parse(settings[key]);
          if (Array.isArray(parsed)) {
            parsed.forEach(n => {
              if (n && !numbers.includes(n)) numbers.push(n);
            });
          }
        } catch {}
      }
    });

    if (numbers.length === 0) {
      console.warn('[DB Backup] No WhatsApp numbers configured. Skipping WhatsApp document transmission.');
      return;
    }

    let captionText = `💾 *النسخ الاحتياطي التلقائي (كل 5 ساعات)*\n\n`;
    if (reason === 'manual') {
      captionText = `💾 *النسخ الاحتياطي الفوري (يدوي من لوحة التحكم)*\n\n`;
    } else if (reason === 'fallback-switch' || reason === 'recovered') {
      captionText = `⚠️ *نسخة احتياطية طارئة - تغيير حالة قاعدة البيانات (${reason})*\n\n`;
    }
    captionText += `📦 تم إنشاء وحفظ نسخة احتياطية كاملة لجداول وبيانات الموقع على السيرفر.\n`;
    captionText += `📁 *الملف المرفق:* \`${path.basename(backupPath)}\`\n\n`;
    captionText += `🛡️ *نظام الحماية والأمان — عرب تك سيرفر*`;

    await wa.sendDocument(numbers, backupPath, captionText);
    console.log(`[DB Backup] Backup document successfully sent to WhatsApp (${numbers.join(', ')}) ✓`);
  } catch (error) {
    console.warn('[DB Backup] Failed to send backup document via WhatsApp:', error.message);
  }
}

async function sendAdminAlert(message) {
  const signature = message;
  const now = Date.now();
  if (signature === lastAlertSignature && now < alertCooldownUntil) {
    return;
  }

  lastAlertSignature = signature;
  alertCooldownUntil = now + 10 * 60 * 1000;

  console.warn(`[DB Alert] ${message}`);

  try {
    if (wa.getStatus() !== 'ready') {
      return;
    }

    const settings = await readSettingsMap();
    const numbersRaw = settings.whatsapp_numbers;
    if (!numbersRaw) {
      return;
    }

    let numbers = [];
    try {
      numbers = JSON.parse(numbersRaw);
    } catch {
      numbers = [];
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
      return;
    }

    await wa.sendMessage(numbers, `⚠️ تنبيه قاعدة البيانات:\n${message}`);
  } catch (error) {
    console.warn('[DB Alert] Failed to send WhatsApp notification:', error.message);
  }
}

async function writeBackupSnapshot(reason = 'scheduled') {
  ensureDir(BACKUP_DIR);
  ensureDir(FALLBACK_COPY_DIR);

  const mode = getDatabaseMode();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${timestamp}-${reason}.json`;
  const targetDir = mode.fallbackMode ? FALLBACK_COPY_DIR : BACKUP_DIR;
  const backupPath = path.join(targetDir, fileName);

  const snapshot = {
    created_at: new Date().toISOString(),
    reason,
    fallbackMode: mode.fallbackMode,
    tables: {},
  };

  let fileWritten = false;

  if (mode.fallbackMode) {
    const dbPath = path.join(__dirname, '..', 'database.json');
    if (fs.existsSync(dbPath)) {
      // Stream the backup to avoid Out-Of-Memory (OOM) errors for large databases
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(backupPath);
        writeStream.on('error', reject);
        
        const prefix = JSON.stringify({
          created_at: snapshot.created_at,
          reason: snapshot.reason,
          fallbackMode: snapshot.fallbackMode,
          source: 'database.json'
        }, null, 2).slice(0, -2); // Remove the closing `\n}`
        
        writeStream.write(prefix + ',\n  "tables": ');
        
        const readStream = fs.createReadStream(dbPath, { encoding: 'utf8' });
        readStream.on('error', reject);
        
        readStream.pipe(writeStream, { end: false });
        
        readStream.on('end', () => {
          writeStream.write('\n}\n');
          writeStream.end();
        });
        
        writeStream.on('finish', () => {
          fileWritten = true;
          resolve();
        });
      });
    } else {
      snapshot.source = 'database.json';
      snapshot.tables = {};
    }
  } else {
    const tables = ['users', 'categories', 'services', 'orders', 'customers', 'banners', 'wallet_requests', 'wallet_transactions', 'settings', 'customer_discounts', 'reviews'];
    for (const table of tables) {
      try {
        snapshot.tables[table] = table === 'settings'
          ? await allQuery('SELECT * FROM settings')
          : await allQuery(`SELECT * FROM ${table} ORDER BY id DESC`);
      } catch (error) {
        snapshot.tables[table] = { error: error.message };
      }
    }
  }

  if (!fileWritten) {
    fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
  }

  // Prune old backups (keep only latest 5)
  try {
    const files = fs.readdirSync(targetDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ name: f, time: fs.statSync(path.join(targetDir, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time); // newest first
      
    if (files.length > 5) {
      const filesToDelete = files.slice(5);
      filesToDelete.forEach(file => {
        fs.unlinkSync(path.join(targetDir, file.name));
        console.log(`[DB Backup] Pruned old backup: ${file.name}`);
      });
    }
  } catch (err) {
    console.warn('[DB Backup] Failed to prune old backups:', err.message);
  }

  // Send to WhatsApp if scheduled or manual
  if (reason !== 'startup') {
    await sendBackupViaWhatsApp(backupPath, reason);
  }

  return backupPath;
}

async function handleDatabaseModeChange(event) {
  if (event && event.fallbackMode) {
    if (process.env.USE_LOCAL_JSON_DB === 'true') {
      console.log('[DB Backup] Local JSON database mode is enabled. Skipping remote PostgreSQL alert.');
    } else {
      await sendAdminAlert(`PostgreSQL تعذر الوصول إليه، وتم تفعيل fallback على JSON. السبب: ${event.reason || 'غير معروف'}`);
    }
    await writeBackupSnapshot('fallback-switch');
    return;
  }

  await sendAdminAlert('قاعدة البيانات عادت للعمل على PostgreSQL بنجاح.');
  await writeBackupSnapshot('recovered');
}

async function handleDatabaseAlert(event) {
  if (!event || !event.message) {
    return;
  }

  await sendAdminAlert(event.message);
}

function startDatabaseBackupScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  ensureDir(BACKUP_DIR);
  ensureDir(FALLBACK_COPY_DIR);

  onDatabaseModeChange((event) => {
    handleDatabaseModeChange(event).catch((error) => {
      console.warn('[DB Backup] Mode change handler failed:', error.message);
    });
  });

  onDatabaseAlert((event) => {
    handleDatabaseAlert(event).catch((error) => {
      console.warn('[DB Backup] Alert handler failed:', error.message);
    });
  });

  const currentMode = getDatabaseMode();
  if (currentMode.fallbackMode) {
    handleDatabaseModeChange({
      fallbackMode: true,
      reason: 'startup-detected-fallback',
    }).catch((error) => {
      console.warn('[DB Backup] Startup fallback handler failed:', error.message);
    });
  }

  setTimeout(() => {
    writeBackupSnapshot('startup').catch((error) => {
      console.warn('[DB Backup] Startup backup failed:', error.message);
    });
  }, BACKUP_START_DELAY_MS);

  setInterval(() => {
    writeBackupSnapshot('scheduled').catch((error) => {
      console.warn('[DB Backup] Scheduled backup failed:', error.message);
    });
  }, BACKUP_INTERVAL_MS);

  console.log(`[DB Backup] Scheduler started. Interval: ${BACKUP_INTERVAL_MS}ms`);
}

module.exports = {
  startDatabaseBackupScheduler,
  writeBackupSnapshot,
  sendBackupViaWhatsApp,
};
