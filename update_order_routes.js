const fs = require('fs');
let code = fs.readFileSync('routes/orderRoutes.js', 'utf8');

const target = `    // Auto-submit API orders paid with wallet balance in BACKGROUND (fire-and-forget)
    // This prevents timeout-caused duplicate submissions from the frontend
    let autoSubmitted = false;
    if (normalizedPaymentMethod === 'wallet' && serviceInfo.api_source === 'amrr-unlocker') {
      const autoSubmitSetting = await getQuery("SELECT value FROM settings WHERE key = 'api_auto_submit'");
      const isAutoSubmitEnabled = autoSubmitSetting ? autoSubmitSetting.value === 'true' : false; // Disabled by default per user request
      if (isAutoSubmitEnabled) {
        autoSubmitted = true;
        const orderId = result.lastID;
        ;(async () => {
          try {
            console.log(\`[Auto Submit] Placing API order for order #\${orderId} in background...\`);
            await unlockerRoutes.autoSubmitUnlockerOrder(orderId);
          } catch (e) {
            console.error(\`[Auto Submit Error] Failed to place order #\${orderId}:\`, e.message);
          }
        })();
      }
    }`;

const replacement = `    // Telegram API Order Approval handling
    let autoSubmitted = false;
    let pendingApiApproval = false;
    if (normalizedPaymentMethod === 'wallet' && serviceInfo.api_source === 'amrr-unlocker') {
      const autoSubmitSetting = await getQuery("SELECT value FROM settings WHERE key = 'api_auto_submit'");
      const isAutoSubmitEnabled = autoSubmitSetting ? autoSubmitSetting.value === 'true' : false;
      if (isAutoSubmitEnabled) {
        pendingApiApproval = true;
      }
    }`;

code = code.replace(target, replacement);

const tgTarget = `          for (const chatId of adminChatIds) {
            if (savedReceiptPath) {
              const fullImagePath = path.join(__dirname, '..', savedReceiptPath);
              await telegram.sendPhoto(String(chatId), fullImagePath, tgMsg).catch(() => {});
            } else {
              await telegram.sendMessage(String(chatId), tgMsg).catch(() => {});
            }
          }`;

const tgReplacement = `          for (const chatId of adminChatIds) {
            let reply_markup = undefined;
            if (pendingApiApproval) {
               reply_markup = {
                 inline_keyboard: [
                   [{ text: "? ????? ?????? (API)", callback_data: "approve_api_" + orderId }]
                 ]
               };
            }
            if (savedReceiptPath) {
              const fullImagePath = path.join(__dirname, '..', savedReceiptPath);
              await telegram.sendPhoto(String(chatId), fullImagePath, tgMsg, reply_markup).catch(() => {});
            } else {
              await telegram.sendMessage(String(chatId), tgMsg, reply_markup).catch(() => {});
            }
          }`;

code = code.replace(tgTarget, tgReplacement);
fs.writeFileSync('routes/orderRoutes.js', code);
console.log("Done");
