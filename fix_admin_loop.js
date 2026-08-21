const fs = require('fs');
let code = fs.readFileSync('routes/orderRoutes.js', 'utf8');

const targetRegex = /for \(const chatId of adminChatIds\) \{\s*if \(savedReceiptPath\) \{\s*const fullImagePath = path\.join\(__dirname, '\.\.', savedReceiptPath\);\s*await telegram\.sendPhoto\(String\(chatId\), fullImagePath, tgMsg\)\.catch\(\(\) => \{\}\);\s*\} else \{\s*await telegram\.sendMessage\(String\(chatId\), tgMsg\)\.catch\(\(\) => \{\}\);\s*\}\s*\}/g;

const replacement = `for (const chatId of adminChatIds) {
              let keyboard = null;
              if (serviceInfo.api_provider_id && !autoSubmitted) {
                keyboard = {
                  inline_keyboard: [
                    [{ text: '?? ????? ??????', callback_data: \`approve_api_\${orderId}\` }]
                  ]
                };
              }
              if (savedReceiptPath) {
                const fullImagePath = path.join(__dirname, '..', savedReceiptPath);
                await telegram.sendPhoto(String(chatId), fullImagePath, tgMsg, keyboard).catch(() => {});
              } else {
                await telegram.sendMessage(String(chatId), tgMsg, keyboard).catch(() => {});
              }
            }`;

if (targetRegex.test(code)) {
    code = code.replace(targetRegex, replacement);
    fs.writeFileSync('routes/orderRoutes.js', code);
    console.log("Fixed adminChatIds loop");
} else {
    console.log("Target not found!");
}
