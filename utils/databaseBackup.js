const fs = require('fs');
const path = require('path');
const { allQuery, getDatabaseMode, onDatabaseAlert, onDatabaseModeChange } = require('../db');
const wa = require('../whatsapp');
const telegram = require('./telegramService');

const BACKUP_ROOT = path.join(__dirname, '..', 'backups');
const BACKUP_DIR = path.join(BACKUP_ROOT, 'database');
const FALLBACK_COPY_DIR = path.join(BACKUP_ROOT, 'fallback');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // exactly once per day
const BACKUP_START_DELAY_MS = Number(process.env.DB_BACKUP_START_DELAY_MS) || 60 * 1000;

let schedulerStarted = false;
let lastAlertSignature = '';
let alertCooldownUntil = 0;
const EXCLUDED_TABLES = new Set(['categories', 'services']);

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

async function sendBackupViaTelegram(backupPath, reason = 'scheduled') {
  try {
    const chatIds = await telegram.getAdminChatIds();
    if (!chatIds.length) {
      console.warn('[DB Backup] No Telegram admin chat IDs configured.');
      return { sent: 0, total: 0 };
    }
    const label = reason === 'manual' ? 'يدوية' : reason === 'scheduled' ? 'يومية تلقائية' : 'طارئة';
    const caption = `💾 نسخة احتياطية ${label}\n📅 ${new Date().toLocaleString('ar-EG')}\n✅ تشمل كل بيانات الموقع والطلبات وعلاقاتها\n⛔ لا تشمل الخدمات والأقسام`;
    let sentCount = 0;
    for (const chatId of chatIds) {
      const sent = await telegram.sendDocument(String(chatId), backupPath, caption);
      if (sent) {
        sentCount += 1;
        console.log(`[DB Backup] Backup sent to Telegram admin ${chatId} successfully.`);
      } else {
        console.warn(`[DB Backup] Telegram delivery failed for admin ${chatId}.`);
      }
    }
    return { sent: sentCount, total: chatIds.length };
  } catch (error) {
    console.warn('[DB Backup] Failed to send backup via Telegram:', error.message);
    return { sent: 0, total: 0, error: error.message };
  }
}

async function getBackupTableNames(mode, includeAll = false) {
  if (mode.fallbackMode) {
    const { readDb } = require('../db');
    return Object.keys(readDb()).filter(name => includeAll || !EXCLUDED_TABLES.has(name));
  }
  const rows = await allQuery(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  return rows.map(row => row.table_name).filter(name => includeAll || !EXCLUDED_TABLES.has(name));
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
    const { readDb } = require('../db');
    const dbData = readDb();
    for (const table of await getBackupTableNames(mode)) snapshot.tables[table] = dbData[table] || [];
  } else {
    for (const table of await getBackupTableNames(mode)) {
      try {
        const rows = await allQuery(`SELECT * FROM ${table}`);
        snapshot.tables[table] = rows || [];
      } catch (err) {
        console.warn(`[DB Backup] Failed to read table ${table}:`, err.message);
      }
    }
  }

  try {
    fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), 'utf8');
    fileWritten = true;
    console.log(`[DB Backup] Snapshot saved to ${backupPath}`);
  } catch (err) {
    console.warn('[DB Backup] Failed to write backup file:', err.message);
  }

  if (!fileWritten) return null;

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

  // Send every non-startup backup to the configured administrators.
  if (reason !== 'startup') {
    await Promise.all([
      sendBackupViaWhatsApp(backupPath, reason),
      sendBackupViaTelegram(backupPath, reason),
    ]);
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

  const runDailyBackup = () => {
    writeBackupSnapshot('scheduled').catch((error) => {
      console.warn('[DB Backup] Scheduled backup failed:', error.message);
    });
  };

  // Send the first daily backup shortly after startup, then every 24 hours.
  setTimeout(() => {
    runDailyBackup();
    setInterval(runDailyBackup, BACKUP_INTERVAL_MS);
  }, BACKUP_START_DELAY_MS);

  console.log(`[DB Backup] Daily scheduler started. Interval: ${BACKUP_INTERVAL_MS}ms`);
}

module.exports = {
  startDatabaseBackupScheduler,
  writeBackupSnapshot,
  sendBackupViaWhatsApp,
  sendBackupViaTelegram,
  getBackupTableNames,
};
