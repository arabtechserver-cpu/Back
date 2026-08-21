const fs = require('fs');
let code = fs.readFileSync('utils/telegramService.js', 'utf8');

const target = `async function sendPhoto(chatId, imageSource, caption = '', parseMode = 'Markdown') {
  if (!chatId || !imageSource) return false;
  try {
    const FormData = require('form-data');
    const fs = require('fs');
    const form = new FormData();
    form.append('chat_id', chatId);
    if (imageSource.startsWith('http')) {
      form.append('photo', imageSource);
    } else {
      if (fs.existsSync(imageSource)) {
        form.append('photo', fs.createReadStream(imageSource));
      } else {
        return false;
      }
    }
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', parseMode);
    }`;

const replacement = `async function sendPhoto(chatId, imageSource, caption = '', replyMarkup = null, parseMode = 'Markdown') {
  if (!chatId || !imageSource) return false;
  try {
    const FormData = require('form-data');
    const fs = require('fs');
    const form = new FormData();
    form.append('chat_id', chatId);
    if (imageSource.startsWith('http')) {
      form.append('photo', imageSource);
    } else {
      if (fs.existsSync(imageSource)) {
        form.append('photo', fs.createReadStream(imageSource));
      } else {
        return false;
      }
    }
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', parseMode);
    }
    if (replyMarkup) {
      form.append('reply_markup', JSON.stringify(replyMarkup));
    }`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('utils/telegramService.js', code);
    console.log("Fixed sendPhoto");
} else {
    console.log("Target not found!");
}
