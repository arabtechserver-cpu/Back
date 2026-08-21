const fs = require('fs');
let code = fs.readFileSync('utils/telegramService.js', 'utf8');

const injection = `
  // Admin: Approve API Order
  if (data.startsWith('approve_api_')) {
    const adminChatIds = await getAdminChatIds();
    if (!adminChatIds.includes(String(chatId))) {
      await answerCallbackQuery(cbId, "This action is for admins only", true);
      return;
    }
    const orderId = data.replace('approve_api_', '');
    try {
      const unlockerRoutes = require('../routes/unlockerRoutes');
      await unlockerRoutes.autoSubmitUnlockerOrder(orderId);
      
      const newMarkup = { inline_keyboard: [[{ text: '\u062A\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0648\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0637\u0644\u0628 \u0628\u0646\u062C\u0627\u062D', callback_data: 'noop' }]] };
      
      if (callbackQuery.message.photo) {
        await tgRequest('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          reply_markup: newMarkup
        }).catch(()=>null);
      } else {
        await tgRequest('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: callbackQuery.message.message_id,
          reply_markup: newMarkup
        }).catch(()=>null);
      }
      await answerCallbackQuery(cbId, "API Order Sent Successfully!");
    } catch (err) {
      console.error("Failed to submit API order via Telegram:", err);
      await answerCallbackQuery(cbId, "Error: " + err.message, true);
    }
    return;
  }
`;

code = code.replace(
  /\/\/ Identify Customer/,
  injection + '\n  // Identify Customer'
);

fs.writeFileSync('utils/telegramService.js', code);
console.log("Injected properly");
