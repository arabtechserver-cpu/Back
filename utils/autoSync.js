const unlockerRoutes = require('../routes/unlockerRoutes');
const wa = require('../whatsapp');
const { getQuery, allQuery } = require('../db');

// Run auto-sync every 24 hours (86,400,000 ms)
const AUTO_SYNC_INTERVAL_MS = Number(process.env.AUTO_SYNC_INTERVAL_MS) || 24 * 60 * 60 * 1000;
let autoSyncInterval = null;

async function runAutoSync() {
  console.log('[Auto Sync] Starting scheduled smart sync background task...');
  try {
    // Determine if auto-sync is enabled by admin (optional, assuming true by default for now, or you can add a toggle later)
    // For now we will run it if it's scheduled. We don't pass arguments to use the saved default settings from DB
    const result = await unlockerRoutes.performSmartSync();
    
    console.log(`[Auto Sync] Completed successfully: Added ${result.addedCategoriesCount} categories, Added ${result.addedServicesCount} services, Updated ${result.updatedServicesCount} services.`);
    
    // Optionally notify admin via WhatsApp
    if (wa.getStatus() === 'ready') {
      const settingsRows = await allQuery("SELECT value FROM settings WHERE key = 'whatsapp_numbers'");
      let numbers = [];
      if (settingsRows && settingsRows.length > 0) {
        try { numbers = JSON.parse(settingsRows[0].value); } catch {}
      }
      if (numbers.length > 0) {
        const msg = `🔄 *تم إكمال المزامنة التلقائية (Smart Sync) بنجاح!*\n` +
                    `📁 أقسام جديدة: ${result.addedCategoriesCount}\n` +
                    `🆕 خدمات جديدة: ${result.addedServicesCount}\n` +
                    `♻️ خدمات مُحدّثة: ${result.updatedServicesCount}`;
        await wa.sendMessage(numbers, msg);
      }
    }
  } catch (error) {
    console.error('[Auto Sync] Error during background smart sync:', error.message);
  }
}

function startAutoSyncScheduler() {
  if (autoSyncInterval) {
    return;
  }
  
  // Calculate time until 4:00 AM (local server time)
  const now = new Date();
  const target = new Date();
  target.setHours(4, 0, 0, 0);
  if (now.getTime() > target.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  
  const delayUntil4AM = target.getTime() - now.getTime();
  console.log(`[Auto Sync] Scheduler started. Next run at 4:00 AM (in ${Math.floor(delayUntil4AM / 1000 / 60)} minutes).`);
  
  // Wait until 4:00 AM to start the daily interval
  setTimeout(() => {
    runAutoSync(); // run immediately at 4 AM
    autoSyncInterval = setInterval(() => {
      runAutoSync();
    }, AUTO_SYNC_INTERVAL_MS);
  }, delayUntil4AM);
}

module.exports = {
  startAutoSyncScheduler,
  runAutoSync
};
