const fs = require('fs');
let code = fs.readFileSync('utils/telegramService.js', 'utf8');

const target = `    if (data === 'cancel_order') {`;

const replacement = `    // Approve API Order
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
    }

    if (data === 'cancel_order') {`;

code = code.replace(target, replacement);
fs.writeFileSync('utils/telegramService.js', code);
console.log("Done");
