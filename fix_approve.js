const fs = require('fs');
let code = fs.readFileSync('utils/telegramService.js', 'utf8');

const target = `async function processCallbackQuery(callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  const data = callbackQuery.data;
  const cbId = callbackQuery.id;`;

const replacement = `async function processCallbackQuery(callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  const data = callbackQuery.data;
  const cbId = callbackQuery.id;

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
      
      const newMarkup = { inline_keyboard: [[{ text: '?? ???????? ?????? ????? ?????', callback_data: 'noop' }]] };
      
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
  }`;

code = code.replace(target, replacement);
fs.writeFileSync('utils/telegramService.js', code);
console.log("Injected approve_api handler");
