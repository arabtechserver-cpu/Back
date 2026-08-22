const { runQuery } = require('./db');

async function resetAdmins() {
  try {
    console.log("Resetting telegram_admin_chat_ids...");
    await runQuery("UPDATE settings SET value = '[]' WHERE key = 'telegram_admin_chat_ids'");
    console.log("Successfully cleared telegram_admin_chat_ids.");
  } catch (err) {
    console.error("Error clearing admins:", err);
  }
  process.exit(0);
}

resetAdmins();
