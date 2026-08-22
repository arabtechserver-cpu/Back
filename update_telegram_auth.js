const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'utils', 'telegramService.js');
let code = fs.readFileSync(filePath, 'utf8');

if (!code.includes("const emailService = require('./emailService');")) {
    code = code.replace(
        "const { getQuery, runQuery, allQuery } = require('../db');",
        "const { getQuery, runQuery, allQuery } = require('../db');\nconst emailService = require('./emailService');"
    );
}

// 1. Replace the /start command block
code = code.replace(
    /if \(text === '\/start' \|\| text\.startsWith\('\/start '\)\) \{[\s\S]*?return sendMessage[\s\S]*?\}\n  \}/g,
    `if (text === '/start' || text.startsWith('/start ')) {
    const customer = await getQuery('SELECT * FROM customers WHERE telegram_chat_id = ?', [chatId]);
    const buttons = [[{ text: '🛒 تصفح الخدمات والأسعار', callback_data: 'browse_cats' }]];
    
    let welcomeMsg = \`👋 مرحباً بك في بوت *عرب تك سيرفر*!\\n\\n📌 *قائمة الأوامر المتاحة:*\\n🔎 \\\`/track 1005\\\` - لتتبع طلب محدد برقمه\\n🔗 \\\`/unlink\\\` - لإلغاء ربط حسابك بهذا البوت\\n\\n\`;
    
    if (!customer) {
      welcomeMsg += \`⚠️ *أول مرة هنا؟* يجب عليك تسجيل الدخول أولاً لتتمكن من الشراء ومتابعة طلباتك.\\n\\nالرجاء اختيار طريقة تسجيل الدخول أو الربط من الأزرار بالأسفل:\`;
      buttons.push([{ text: '🔐 ربط بحساب موجود (اسم المستخدم وكلمة المرور)', callback_data: 'login_normal' }]);
      buttons.push([{ text: '🌐 ربط بحساب جوجل (OTP)', callback_data: 'login_google' }]);
    } else {
      welcomeMsg += \`👤 الحساب المرتبط: *\${customer.username}*\\nيمكنك الآن تصفح الخدمات والطلب مباشرة.\`;
    }

    return sendMessage(chatId, welcomeMsg, {
      inline_keyboard: buttons
    });
  }`
);

// 2. Remove the old linking flow
code = code.replace(
    /\/\/ Try linking account if not a command[\s\S]*?catch \(err\) \{\n\s*console\.error\('\[Telegram\] Error linking customer:', err\.message\);\n\s*\}\n\s*\}/g,
    `// Try linking account if not a command removed for security.`
);

// 3. Add handle messages for the new login states
code = code.replace(
    /if \(userState\.state === 'AWAITING_PLAYER_ID'\) \{/g,
    `if (userState.state === 'AWAITING_CUSTOMER_USERNAME') {
    if (text === '/cancel') {
      clearUserState(chatId);
      return sendMessage(chatId, '❌ تم إلغاء عملية التسجيل.');
    }
    setUserState(chatId, 'AWAITING_CUSTOMER_PASSWORD', { username: text.trim() });
    return sendMessage(chatId, '🔑 يرجى إرسال **كلمة المرور (Password)** الخاصة بحسابك في الموقع:\\n\\n_(أرسل /cancel للإلغاء)_');
  }

  if (userState.state === 'AWAITING_CUSTOMER_PASSWORD') {
    if (text === '/cancel') {
      clearUserState(chatId);
      return sendMessage(chatId, '❌ تم إلغاء عملية التسجيل.');
    }
    const username = userState.data.username;
    const password = text;
    clearUserState(chatId);
    try {
      const cust = await getQuery('SELECT * FROM customers WHERE username = ? OR email = ? OR phone = ?', [username, username, username]);
      if (!cust) return sendMessage(chatId, '❌ الحساب غير موجود.');
      
      const isMatch = await bcrypt.compare(password, cust.password);
      if (!isMatch) return sendMessage(chatId, '❌ كلمة المرور غير صحيحة.');
      
      await runQuery('UPDATE customers SET telegram_chat_id = ? WHERE id = ?', [chatId, cust.id]);
      return sendMessage(chatId, \`✅ *تم ربط حسابك بنجاح!*\\n\\n👤 الحساب: *\${cust.username}*\\n\\nيمكنك الآن استخدام البوت للطلب ومتابعة الرصيد 🚀\`);
    } catch(err) {
      console.error(err);
      return sendMessage(chatId, '❌ حدث خطأ أثناء التحقق.');
    }
  }

  if (userState.state === 'AWAITING_CUSTOMER_GOOGLE_EMAIL') {
    if (text === '/cancel') {
      clearUserState(chatId);
      return sendMessage(chatId, '❌ تم إلغاء عملية التسجيل.');
    }
    const email = text.trim();
    const cust = await getQuery('SELECT * FROM customers WHERE email = ?', [email]);
    if (!cust) return sendMessage(chatId, '❌ هذا البريد غير مسجل لدينا في النظام.');
    
    // Generate OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    // Save to DB temporarily
    await runQuery('UPDATE customers SET reset_otp = ?, reset_otp_expires = ? WHERE id = ?', [code, new Date(Date.now() + 10*60000), cust.id]);
    
    try {
      await emailService.sendCustomerAuthOtpEmail(email, {
        code,
        username: cust.username,
        actionLabel: 'ربط حسابك بالتيليجرام'
      });
      setUserState(chatId, 'AWAITING_CUSTOMER_GOOGLE_OTP', { email: email });
      return sendMessage(chatId, \`📩 تم إرسال رمز تحقق (OTP) إلى بريدك:\\n*\${email}*\\n\\nيرجى كتابة الرمز هنا للتحقق:\\n\\n_(أرسل /cancel للإلغاء)_\`);
    } catch(err) {
      console.error('Error sending OTP:', err);
      clearUserState(chatId);
      return sendMessage(chatId, '❌ فشل إرسال الإيميل. تأكد من إعدادات الإيميل في السيرفر أو جرب لاحقاً.');
    }
  }

  if (userState.state === 'AWAITING_CUSTOMER_GOOGLE_OTP') {
    if (text === '/cancel') {
      clearUserState(chatId);
      return sendMessage(chatId, '❌ تم إلغاء عملية التسجيل.');
    }
    const otp = text.trim();
    const email = userState.data.email;
    const cust = await getQuery('SELECT * FROM customers WHERE email = ? AND reset_otp = ? AND reset_otp_expires > NOW()', [email, otp]);
    
    if (!cust) return sendMessage(chatId, '❌ الرمز غير صحيح أو منتهي الصلاحية.');
    
    clearUserState(chatId);
    await runQuery('UPDATE customers SET telegram_chat_id = ?, reset_otp = NULL, reset_otp_expires = NULL WHERE id = ?', [chatId, cust.id]);
    return sendMessage(chatId, \`✅ *تم التحقق وربط حسابك بنجاح!*\\n\\n👤 الحساب: *\${cust.username}*\\n\\nيمكنك الآن الشراء بحرية من البوت 🚀\`);
  }

  if (userState.state === 'AWAITING_ORDER_FIELD') {
    if (text === '/cancel') {
      clearUserState(chatId);
      return sendMessage(chatId, '❌ تم إلغاء الطلب.');
    }
    
    const data = userState.data;
    data.collected_fields.push({ id: data.fields[data.current_field_index].id, name: data.fields[data.current_field_index].name, value: text });
    data.current_field_index++;
    
    if (data.current_field_index < data.fields.length) {
       setUserState(chatId, 'AWAITING_ORDER_FIELD', data);
       const nextField = data.fields[data.current_field_index];
       return sendMessage(chatId, \`✏️ الرجاء إرسال **\${nextField.name}**:\\n\\n_(أرسل /cancel للإلغاء)_\`, {parse_mode: 'Markdown'});
    } else {
       setUserState(chatId, 'CONFIRM_ORDER', data);
       let fieldsStr = data.collected_fields.map(f => \`\${f.name}: \${f.value}\`).join('\\n');
       const summary = \`🧾 *مراجعة الطلب النهائي*\\n\\n\` +
         \`الخدمة: *\${data.service_name}*\\n\` +
         \`الباقة: *\${data.package_name}*\\n\` +
         \`السعر: *$\${data.package_price}*\\n\\n\` +
         \`*بيانات الطلب:*\\n\${fieldsStr}\\n\\n\` +
         \`سيتم الخصم من رصيد محفظتك. هل أنت متأكد؟\`;
   
       return sendMessage(chatId, summary, {
         inline_keyboard: [
           [{ text: '✅ تأكيد وطلب', callback_data: 'confirm_order' }],
           [{ text: '❌ إلغاء الطلب', callback_data: 'cancel_order' }]
         ]
       });
    }
  }

  if (userState.state === 'AWAITING_PLAYER_ID') {`
);

// 4. Update callback queries
code = code.replace(
    /if \(data === 'browse_cats'\) \{/g,
    `if (data === 'login_normal') {
    setUserState(chatId, 'AWAITING_CUSTOMER_USERNAME', {});
    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: '🔐 *تسجيل الدخول*\\n\\nيرجى إرسال **اسم المستخدم (Username)** أو **الإيميل** الخاص بحسابك:\\n\\n_(أرسل /cancel للإلغاء)_',
      parse_mode: 'Markdown'
    });
    return;
  }
  
  if (data === 'login_google') {
    setUserState(chatId, 'AWAITING_CUSTOMER_GOOGLE_EMAIL', {});
    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: '🌐 *الربط عن طريق جوجل*\\n\\nيرجى إرسال **الإيميل (Email)** الذي سجلت به باستخدام جوجل:\\n\\n_(أرسل /cancel للإلغاء)_',
      parse_mode: 'Markdown'
    });
    return;
  }

  if (data === 'browse_cats') {`
);

code = code.replace(
    /if \(data\.startsWith\('pkg_'\)\) \{[\s\S]*?return;\n  \}/g,
    `if (data.startsWith('pkg_')) {
    const customer = await getQuery('SELECT * FROM customers WHERE telegram_chat_id = ?', [chatId]);
    if (!customer) {
      await answerCallbackQuery(cbId, '❌ يجب ربط حسابك أولاً لتتمكن من الشراء!', true);
      return;
    }

    const parts = data.split('_');
    const srvId = parts[1];
    const pkgIndex = parts[2];
    
    const service = await getQuery('SELECT * FROM services WHERE id = ?', [srvId]);
    let packages = JSON.parse(service.packages);
    const selectedPkg = packages[pkgIndex];
    
    let fields = [];
    try {
      const category = await getQuery('SELECT fields FROM categories WHERE id = ?', [service.category_id]);
      if (category && category.fields) {
        fields = typeof category.fields === 'string' ? JSON.parse(category.fields) : category.fields;
      }
    } catch(e) {}
    
    // If no custom fields configured, fallback to player_id
    if (!fields || fields.length === 0) {
      fields = [{ id: 'player_id', name: 'معرف اللاعب أو الرابط', type: 'text' }];
    }

    setUserState(chatId, 'AWAITING_ORDER_FIELD', {
      service_id: service.id,
      service_name: service.name,
      package_name: selectedPkg.name,
      package_price: Number(selectedPkg.price),
      api_source: service.api_source || '',
      download_link: service.download_link || '',
      download_link_title: service.download_link_title || '',
      fields: fields,
      current_field_index: 0,
      collected_fields: []
    });

    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: \`✏️ لقد اخترت باقة *\${selectedPkg.name}*\\n\\nالرجاء إرسال **\${fields[0].name}** في رسالة الآن:\\n\\n_(أو أرسل /cancel للإلغاء)_\`,
      parse_mode: 'Markdown'
    });
    await answerCallbackQuery(cbId);
    return;
  }`
);

// 5. Update confirm_order logic to use the collected fields array
code = code.replace(
    /let playerId = orderData\.player_id \|\| '';/g,
    `let playerId = orderData.player_id || '';
    if (orderData.collected_fields && orderData.collected_fields.length > 0) {
      let formattedFields = {};
      orderData.collected_fields.forEach(f => {
         formattedFields[f.id] = f.value;
      });
      if (orderData.collected_fields.length === 1 && orderData.collected_fields[0].id === 'player_id') {
         playerId = orderData.collected_fields[0].value;
      } else {
         playerId = JSON.stringify(formattedFields);
      }
    }`
);

fs.writeFileSync(filePath, code);
console.log('Update applied successfully!');
