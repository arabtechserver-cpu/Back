const fs = require('fs');
let code = fs.readFileSync('utils/telegramService.js', 'utf8');

code = code.replace(
    /async function sendPhoto\(chatId, imageSource, caption = '', parseMode = 'Markdown'\) {[\s\S]*?form\.append\('parse_mode', parseMode\);/,
    `async function sendPhoto(chatId, imageSource, caption = '', replyMarkup = null, parseMode = 'Markdown') {
  if (!chatId || !imageSource) return false;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', parseMode);
    if (replyMarkup) {
      form.append('reply_markup', JSON.stringify(replyMarkup));
    }`
);

fs.writeFileSync('utils/telegramService.js', code);
console.log("Fixed sendPhoto regex");
