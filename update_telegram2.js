const fs = require('fs');
let code = fs.readFileSync('utils/telegramService.js', 'utf8');

const targetToRemove = `    // Approve API Order
    if (data.startsWith('approve_api_')) {
      const orderId = data.replace('approve_api_', '');
      try {
        const unlockerRoutes = require('../routes/unlockerRoutes');
        await unlockerRoutes.autoSubmitUnlockerOrder(orderId);
        
        await tgRequest('editMessageText', {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          text: callbackQuery.message.text + "\n\n? *?? ???????? ?????? ????? ?????? ?????*",
          parse_mode: 'Markdown'
        });
        await answerCallbackQuery(cbId, "?? ????? ????? ?????? ?????!");
      } catch (err) {
        console.error("Failed to submit API order via Telegram:", err);
        await answerCallbackQuery(cbId, "??? ???????: " + err.message, true);
      }
      return;
    }`;

code = code.replace(targetToRemove, "");

const newTarget = `  // Identify Customer
    const customer = await getQuery('SELECT * FROM customers WHERE telegram_chat_id = ?', [chatId]);`;

const newReplacement = `    // Admin: Approve API Order
    if (data.startsWith('approve_api_')) {
      const adminChatIds = await getAdminChatIds();
      if (!adminChatIds.includes(String(chatId))) {
        await answerCallbackQuery(cbId, "?????? ??? ??????? ????????? ???!", true);
        return;
      }
      const orderId = data.replace('approve_api_', '');
      try {
        const unlockerRoutes = require('../routes/unlockerRoutes');
        await unlockerRoutes.autoSubmitUnlockerOrder(orderId);
        
        await tgRequest('editMessageText', {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          text: callbackQuery.message.text + "\n\n? *?? ???????? ?????? ????? ?????? ?????*",
          parse_mode: 'Markdown'
        });
        await answerCallbackQuery(cbId, "?? ????? ????? ?????? ?????!");
      } catch (err) {
        console.error("Failed to submit API order via Telegram:", err);
        await answerCallbackQuery(cbId, "??? ???????: " + err.message, true);
      }
      return;
    }

    // Identify Customer
    const customer = await getQuery('SELECT * FROM customers WHERE telegram_chat_id = ?', [chatId]);`;

code = code.replace(newTarget, newReplacement);
fs.writeFileSync('utils/telegramService.js', code);
console.log("Done");
