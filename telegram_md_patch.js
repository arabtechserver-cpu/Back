const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'utils', 'telegramService.js');
let code = fs.readFileSync(filePath, 'utf8');

// 1. Fix line 484 Markdown issue
code = code.replace(
    /text: `✏️ لقد اخترت باقة \*\$\{selectedPkg\.name\}\*\\n\\nالرجاء إرسال \*\*\$\{fields\[0\]\.name\}\*\* في رسالة الآن:\\n\\n_\(أو أرسل \/cancel للإلغاء\)_`,\s*parse_mode: 'Markdown'/g,
    `text: \`✏️ لقد اخترت باقة <b>\${selectedPkg.name}</b>\\n\\nالرجاء إرسال <b>\${fields[0].name}</b> في رسالة الآن:\\n\\n<i>(أو أرسل /cancel للإلغاء)</i>\`,\n      parse_mode: 'HTML'`
);

// 2. Fix line 765 Markdown issue
code = code.replace(
    /return sendMessage\(chatId, `✏️ الرجاء إرسال \*\*\$\{nextField\.name\}\*\*:\\n\\n_\(أرسل \/cancel للإلغاء\)_`, \{parse_mode: 'Markdown'\}\);/g,
    `return sendMessage(chatId, \`✏️ الرجاء إرسال <b>\${nextField.name}</b>:\\n\\n<i>(أرسل /cancel للإلغاء)</i>\`, {parse_mode: 'HTML'});`
);

// 3. Fix line 782-786 Markdown issue
code = code.replace(
    /const summary = `🧾 \*مراجعة الطلب النهائي\*\\n\\n` \+\s*`الخدمة: \*\$\{data\.service_name\}\*\\n` \+\s*`الباقة: \*\$\{data\.package_name\}\*\\n` \+\s*`السعر: \*\$\{data\.package_price\}\*\\n\\n` \+\s*`\*بيانات الطلب:\*\\n\$\{fieldsStr\}\\n\\n` \+/g,
    `const summary = \`🧾 <b>مراجعة الطلب النهائي</b>\\n\\n\` +\n         \`الخدمة: <b>\${data.service_name}</b>\\n\` +\n         \`الباقة: <b>\${data.package_name}</b>\\n\` +\n         \`السعر: <b>$\${data.package_price}</b>\\n\\n\` +\n         \`<b>بيانات الطلب:</b>\\n\${fieldsStr}\\n\\n\` +`
);

// Fix parse_mode for confirm_order
code = code.replace(
    /inline_keyboard: \[\s*\[\{ text: '✅ تأكيد الطلب', callback_data: `confirm_order` \}\],\s*\[\{ text: '❌ إلغاء الطلب', callback_data: `cancel_order` \}\]\s*\]\s*\}/g,
    `inline_keyboard: [\n           [{ text: '✅ تأكيد الطلب', callback_data: \`confirm_order\` }],\n           [{ text: '❌ إلغاء الطلب', callback_data: \`cancel_order\` }]\n         ],\n         parse_mode: 'HTML'\n       }`
);

fs.writeFileSync(filePath, code);
console.log('Markdown bugs patched successfully!');
