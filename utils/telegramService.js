/**
 * Telegram Bot Service — عرب تك سيرفر
 * Full Interactive System (OTP, Notifications, Orders Tracking, Direct Ordering)
 */

'use strict';

const https = require('https');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { getQuery, runQuery, allQuery } = require('../db');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902996463:AAE3zudjSRRGwYDHsbtSD_eg2SCYQM8NmjQ';
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── User State (In-Memory) ───────────────────────────────────────────────────
// state structure: { state: 'IDLE', data: {} }
const userStates = new Map();

function getUserState(chatId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, { state: 'IDLE', data: {} });
  }
  return userStates.get(chatId);
}
function setUserState(chatId, state, data = {}) {
  userStates.set(chatId, { state, data });
}
function clearUserState(chatId) {
  userStates.set(chatId, { state: 'IDLE', data: {} });
}

// ── Low-level HTTP helper ─────────────────────────────────────────────────────
const agent = new https.Agent({ keepAlive: true });

function tgRequest(method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      agent: agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, raw: data });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(10000, () => {
      req.destroy(new Error('Telegram API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

// ── Send Message & Keyboards ─────────────────────────────────────────────────
async function sendMessage(chatId, text, replyMarkup = null, parseMode = 'Markdown') {
  if (!chatId || !text) return false;
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }
    const res = await tgRequest('sendMessage', body);
    return res.ok;
  } catch (err) {
    console.error(`[Telegram] sendMessage exception:`, err.message);
    return false;
  }
}

async function sendPhoto(chatId, imageSource, caption = '', replyMarkup = null, parseMode = 'Markdown') {
  if (!chatId || !imageSource) return false;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('parse_mode', parseMode);
    if (replyMarkup) {
      form.append('reply_markup', JSON.stringify(replyMarkup));
    }
    
    if (typeof imageSource === 'string' && imageSource.startsWith('data:image/')) {
      const base64Data = imageSource.split(';base64,').pop();
      const buffer = Buffer.from(base64Data, 'base64');
      form.append('photo', buffer, { filename: 'receipt.jpg' });
    } else if (typeof imageSource === 'string' && fs.existsSync(imageSource)) {
      form.append('photo', fs.createReadStream(imageSource));
    } else {
      form.append('photo', imageSource);
    }

    const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
      headers: form.getHeaders(),
    });
    return res.data && res.data.ok;
  } catch (err) {
    console.error(`[Telegram] sendPhoto exception:`, err.response ? err.response.data : err.message);
    return false;
  }
}

async function sendDocument(chatId, filePath, caption = '') {
  if (!chatId || !filePath || !fs.existsSync(filePath)) return false;
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('document', fs.createReadStream(filePath), { filename: require('path').basename(filePath) });
    const res = await axios.post(`${TG_API}/sendDocument`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    });
    return Boolean(res.data?.ok);
  } catch (err) {
    console.error('[Telegram] sendDocument exception:', err.response?.data || err.message);
    return false;
  }
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  return tgRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

// ── OTP & Notifications (Existing Logic) ──────────────────────────────────────
async function sendCustomerOtp(customerId, code, username, actionLabel) {
  try {
    const row = await getQuery('SELECT telegram_chat_id FROM customers WHERE id = ?', [customerId]);
    if (!row || !row.telegram_chat_id) return false;
    const text =
      `🔐 *عرب تك سيرفر — ${actionLabel || 'تأكيد الهوية'}*\n\n` +
      `مرحباً بك يا *${username}*،\n🔑 كود التحقق (OTP) الخاص بك هو:\n\n\`${code}\`\n\n⏱️ صالح لمدة 10 دقائق.\n🛡️ لا تشاركه مع أحد.`;
    return sendMessage(row.telegram_chat_id, text);
  } catch (err) { return false; }
}

async function sendAdminOtp(code, action, customMessage = '') {
  try {
    const chatIds = await getAdminChatIds();
    if (chatIds.length === 0) return false;
    let actionText = 'إجراء أمان';
    if (action === 'admin_login') actionText = 'تسجيل دخول لوحة التحكم';
    else if (action === 'delete') actionText = 'تأكيد عملية حذف حساسة';
    
    const text = `🔐 *كود تحقق أمان المسؤول (OTP)*\n\n` +
      (customMessage ? `${customMessage}\n\n` : '') +
      `⚡ *الإجراء:* ${actionText}\n🔑 *الكود:*\n\n\`${code}\`\n\n⏱️ صالح لمدة 5 دقائق.`;

    let anySent = false;
    for (const chatId of chatIds) {
      if (await sendMessage(String(chatId), text)) anySent = true;
    }
    return anySent;
  } catch (err) { return false; }
}

async function getAdminChatIds() {
  try {
    const row = await getQuery("SELECT value FROM settings WHERE key = 'telegram_admin_chat_ids'");
    if (!row || !row.value) return [];
    const parsed = JSON.parse(row.value);
    const ids = Array.isArray(parsed) ? parsed : [parsed];
    return [...new Set(ids.map(id => String(id).trim()).filter(Boolean))];
  } catch { return []; }
}
async function isTelegramConfigured() {
  if (!BOT_TOKEN) return false;
  const ids = await getAdminChatIds();
  return ids.length > 0;
}

// ── Interactive Logic ────────────────────────────────────────────────────────

// Handle /orders
async function handleMyOrdersCommand(chatId, customer) {
  const orders = await allQuery('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 5', [customer.id]);
  if (!orders || orders.length === 0) {
    return sendMessage(chatId, '📭 ليس لديك أي طلبات سابقة حتى الآن.');
  }
  let txt = `📦 *أحدث طلباتك (آخر 5 طلبات):*\n\n`;
  orders.forEach(o => {
    let st = o.status === 'completed' ? '✅ مكتمل' : (o.status === 'cancelled' ? '❌ ملغي' : '⏳ جاري المعالجة');
    txt += `▫️ طلب *#${o.id}*\n🎮 ${o.service_name} (${o.package_name})\n💵 السعر: $${o.package_price}\n📌 الحالة: ${st}\n\n`;
  });
  txt += `لتتبع طلب محدد بالتفصيل، استخدم:\n\`/track رقم_الطلب\``;
  return sendMessage(chatId, txt);
}

// Handle /track <id>
async function handleTrackCommand(chatId, customer, orderIdStr) {
  const orderId = parseInt(orderIdStr);
  if (isNaN(orderId)) {
    return sendMessage(chatId, '❌ يرجى كتابة رقم الطلب بشكل صحيح، مثال:\n`/track 1005`');
  }
  const order = await getQuery('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, customer.id]);
  if (!order) {
    return sendMessage(chatId, `❌ لم يتم العثور على طلب برقم #${orderId} في حسابك.`);
  }
  let st = order.status === 'completed' ? '✅ مكتمل' : (order.status === 'cancelled' ? '❌ ملغي' : '⏳ جاري المعالجة');
  let txt = `📦 *تفاصيل الطلب #${order.id}*\n\n`;
  txt += `🎮 الخدمة: *${order.service_name}*\n`;
  txt += `📦 الباقة: *${order.package_name}*\n`;
  txt += `💵 السعر: *$${order.package_price}*\n`;
  txt += `🆔 الآيدي/الرابط: \`${order.player_id}\`\n`;
  txt += `📌 الحالة: *${st}*\n`;
  if (order.code) txt += `\n🔑 كود التفعيل: \`${order.code}\`\n`;
  if (order.download_link) txt += `\n🔗 رابط التحميل: [اضغط هنا](${order.download_link})\n`;
  return sendMessage(chatId, txt);
}

// Show main menu (Categories)
async function showCategories(chatId) {
  const categories = await allQuery('SELECT id, name FROM categories ORDER BY sort_order ASC, id DESC');
  if (!categories || categories.length === 0) {
    return sendMessage(chatId, '❌ لا توجد أقسام متاحة حالياً.');
  }
  
  const keyboard = [];
  // 2 categories per row
  for (let i = 0; i < categories.length; i += 2) {
    const row = [];
    row.push({ text: categories[i].name, callback_data: `cat_${categories[i].id}` });
    if (categories[i + 1]) {
      row.push({ text: categories[i + 1].name, callback_data: `cat_${categories[i + 1].id}` });
    }
    keyboard.push(row);
  }
  keyboard.push([{ text: '❌ إلغاء الطلب', callback_data: 'cancel_order' }]);

  await sendMessage(chatId, '🛒 *طلب خدمة جديدة*\n\nاختر القسم من القائمة التالية:', { inline_keyboard: keyboard });
}

// Process Callbacks
async function processCallbackQuery(callbackQuery) {
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
      
      const newMarkup = { inline_keyboard: [[{ text: 'تم الموافقة وإرسال الطلب بنجاح', callback_data: 'noop' }]] };
      
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

  // Identify Customer
  const customer = await getQuery('SELECT * FROM customers WHERE telegram_chat_id = ?', [chatId]);
  if (!customer) {
    await answerCallbackQuery(cbId, '❌ يجب ربط حسابك أولاً!', true);
    return;
  }

  // Cancel order
  if (data === 'cancel_order') {
    clearUserState(chatId);
    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: '❌ تم إلغاء عملية الطلب.'
    });
    await answerCallbackQuery(cbId);
    return;
  }

  // Handle Category selection
  if (data.startsWith('cat_')) {
    const catId = data.split('_')[1];
    const services = await allQuery('SELECT id, name FROM services WHERE category_id = ? ORDER BY id DESC', [catId]);
    if (!services || services.length === 0) {
      await answerCallbackQuery(cbId, '❌ لا توجد خدمات في هذا القسم.', true);
      return;
    }
    const keyboard = [];
    for (let i = 0; i < services.length; i++) {
      keyboard.push([{ text: services[i].name, callback_data: `srv_${services[i].id}` }]); // 1 per row for services
    }
    keyboard.push([{ text: '↩️ رجوع للأقسام', callback_data: 'back_to_cat' }]);
    keyboard.push([{ text: '❌ إلغاء الطلب', callback_data: 'cancel_order' }]);
    
    await answerCallbackQuery(cbId);
    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: '🎮 *اختر الخدمة المطلوبة:*',
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
    return;
  }

  if (data === 'back_to_cat') {
    // Re-show categories (by deleting current and sending new)
    await tgRequest('deleteMessage', { chat_id: chatId, message_id: callbackQuery.message.message_id }).catch(()=>{});
    await showCategories(chatId);
    await answerCallbackQuery(cbId);
    return;
  }

  // Handle Service selection
  if (data.startsWith('srv_')) {
    const srvId = data.split('_')[1];
    const packagesStr = await getQuery('SELECT packages FROM services WHERE id = ?', [srvId]);
    let packages = [];
    try { packages = JSON.parse(packagesStr.packages); } catch(e){}
    if (!packages || packages.length === 0) {
      await answerCallbackQuery(cbId, '❌ لا توجد باقات لهذه الخدمة.', true);
      return;
    }
    const keyboard = [];
    for (let i = 0; i < packages.length; i++) {
      keyboard.push([{ text: `${packages[i].name} — $${packages[i].price}`, callback_data: `pkg_${srvId}_${i}` }]);
    }
    keyboard.push([{ text: '❌ إلغاء الطلب', callback_data: 'cancel_order' }]);

    await answerCallbackQuery(cbId);
    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: '📦 *اختر الباقة المطلوبة:*',
      reply_markup: { inline_keyboard: keyboard },
      parse_mode: 'Markdown'
    });
    return;
  }

  // Handle Package selection
  if (data.startsWith('pkg_')) {
    const parts = data.split('_');
    const srvId = parts[1];
    const pkgIndex = parts[2];
    
    const service = await getQuery('SELECT * FROM services WHERE id = ?', [srvId]);
    let packages = JSON.parse(service.packages);
    const selectedPkg = packages[pkgIndex];

    setUserState(chatId, 'AWAITING_PLAYER_ID', {
      service_id: service.id,
      service_name: service.name,
      package_name: selectedPkg.name,
      package_price: Number(selectedPkg.price),
      api_source: service.api_source || '',
      download_link: service.download_link || '',
      download_link_title: service.download_link_title || '',
    });

    await tgRequest('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: `✏️ لقد اخترت باقة *${selectedPkg.name}*\n\nالرجاء إرسال *معرف اللاعب (Player ID) أو الرابط* في رسالة الآن:\n\n_(أو أرسل /cancel للإلغاء)_`,
      parse_mode: 'Markdown'
    });
    await answerCallbackQuery(cbId);
    return;
  }

  // Confirm Final Order
  if (data === 'confirm_order') {
    const userState = getUserState(chatId);
    if (userState.state !== 'CONFIRM_ORDER') {
      await answerCallbackQuery(cbId, '❌ جلسة الطلب منتهية.', true);
      return;
    }
    
    const orderData = userState.data;
    
    // Check wallet balance
    const currentCustomer = await getQuery('SELECT * FROM customers WHERE id = ?', [customer.id]);
    const balanceBefore = Number(currentCustomer.balance || 0);
    
    if (balanceBefore < orderData.package_price) {
      clearUserState(chatId);
      await tgRequest('editMessageText', {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        text: `❌ *رصيد محفظتك غير كافٍ!*\nرصيدك الحالي: $${balanceBefore}\nسعر الباقة: $${orderData.package_price}\n\nيرجى شحن المحفظة من الموقع ثم المحاولة مجدداً.`,
        parse_mode: 'Markdown'
      });
      await answerCallbackQuery(cbId);
      return;
    }

    // Process Order
    const balanceAfter = balanceBefore - orderData.package_price;
    const catData = await getQuery('SELECT c.name FROM services s JOIN categories c ON s.category_id = c.id WHERE s.id = ?', [orderData.service_id]);

    try {
      const result = await runQuery(`
        INSERT INTO orders (service_id, service_name, category_name, player_id, phone, package_name, package_price, customer_id, payment_method, sender_phone, transfer_to, quantity, receipt_image, transfer_amount, download_link, download_link_title, api_source, custom_fields)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        orderData.service_id, 
        orderData.service_name, 
        catData ? catData.name : 'Unknown', 
        orderData.player_id, 
        currentCustomer.phone || '', 
        orderData.package_name, 
        orderData.package_price,
        currentCustomer.id,
        'wallet',
        '', // sender_phone
        '', // transfer_to
        1,
        '', // receipt_image
        0, // transfer_amount
        orderData.download_link,
        orderData.download_link_title,
        orderData.api_source,
        '{}'
      ]);

      const orderId = result.lastID;
      
      // Deduct wallet
      await runQuery('UPDATE customers SET balance = ? WHERE id = ?', [balanceAfter, currentCustomer.id]);
      await runQuery(
        'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [currentCustomer.id, currentCustomer.username, 'debit', orderData.package_price, balanceBefore, balanceAfter, 'order', orderId, `شراء خدمة ${orderData.service_name} عبر تيليجرام`]
      );

      clearUserState(chatId);

      await tgRequest('editMessageText', {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        text: `✅ *تم استلام طلبك بنجاح!*\n\nرقم الطلب: *#${orderId}*\nتم خصم *$${orderData.package_price}* من محفظتك.\nالرصيد المتبقي: *$${balanceAfter.toFixed(2)}*\n\nسيتم إشعارك فور اكتمال الطلب.`,
        parse_mode: 'Markdown'
      });
      await answerCallbackQuery(cbId, 'تمت العملية بنجاح!', false);

      // Notify Admins
      const adminChatIds = await getAdminChatIds();
      if (adminChatIds.length > 0) {
        const tgMsg = `🛒 *طلب شحن جديد #${orderId} (عبر تيليجرام)*\n🎮 الخدمة: *${orderData.service_name}*\n📦 الباقة: *${orderData.package_name}* — *${orderData.package_price}*\n🆔 رقم اللاعب: \`${orderData.player_id}\`\n👤 العميل: *${currentCustomer.username}*\n💳 الدفع: 💳 محفظة\n\n🔗 راجع الطلب في لوحة التحكم`;
        for (const adminId of adminChatIds) {
          await sendMessage(String(adminId), tgMsg).catch(() => {});
        }
      }

    } catch (e) {
      console.error(e);
      await answerCallbackQuery(cbId, 'حدث خطأ أثناء معالجة الطلب.', true);
    }
  }
}


// ── Process an incoming Telegram update ───────────────────────────────────────
async function processUpdate(update) {
  if (update.callback_query) {
    return processCallbackQuery(update.callback_query);
  }

  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();

  // Admin Secret Command (Bypasses all states)
  if (text.includes('/admin_secret_9988')) {
    try {
      const row = await getQuery("SELECT value FROM settings WHERE key = 'telegram_admin_chat_ids'");
      let adminIds = [];
      if (row && row.value) {
         try { adminIds = JSON.parse(row.value); } catch(e){}
         if (!Array.isArray(adminIds)) adminIds = [adminIds];
      }
      const strChatId = String(chatId);
      if (!adminIds.includes(strChatId)) {
        adminIds.push(strChatId);
        if (row) {
          await runQuery("UPDATE settings SET value = ? WHERE key = 'telegram_admin_chat_ids'", [JSON.stringify(adminIds)]);
        } else {
          await runQuery("INSERT INTO settings (key, value) VALUES ('telegram_admin_chat_ids', ?)", [JSON.stringify(adminIds)]);
        }
      }
      return sendMessage(chatId, '✅ *تم التفعيل بنجاح!*\nستصلك الآن جميع طلبات العملاء (شحن المحفظة وطلبات الخدمات) هنا.');
    } catch(err) {
      console.error(err);
      return sendMessage(chatId, '❌ حدث خطأ أثناء التسجيل.');
    }
  }

  // Unlink Command (Unlinks customer account)
  if (text === '/unlink') {
    try {
      await runQuery('UPDATE customers SET telegram_chat_id = NULL WHERE telegram_chat_id = ?', [chatId]);
      clearUserState(chatId);
      return sendMessage(chatId, '✅ تم إزالة ربط حسابك من البوت بنجاح.');
    } catch(err) {
      console.error(err);
      return sendMessage(chatId, '❌ حدث خطأ أثناء إزالة الربط.');
    }
  }

  // Handle State Machine inputs
  const userState = getUserState(chatId);
  if (userState.state === 'AWAITING_PLAYER_ID') {
    if (text === '/cancel') {
      clearUserState(chatId);
      return sendMessage(chatId, '❌ تم إلغاء الطلب.');
    }
    
    // Save player ID and move to Confirm
    const data = userState.data;
    data.player_id = text;
    setUserState(chatId, 'CONFIRM_ORDER', data);

    const summary = `🧾 *مراجعة الطلب النهائي*\n\n` +
      `الخدمة: *${data.service_name}*\n` +
      `الباقة: *${data.package_name}*\n` +
      `السعر: *$${data.package_price}*\n` +
      `معرف اللاعب/الرابط: \`${data.player_id}\`\n\n` +
      `سيتم الخصم من رصيد محفظتك. هل أنت متأكد؟`;

    return sendMessage(chatId, summary, {
      inline_keyboard: [
        [{ text: '✅ تأكيد وطلب', callback_data: 'confirm_order' }],
        [{ text: '❌ إلغاء الطلب', callback_data: 'cancel_order' }]
      ]
    });
  }

  // Commands


  if (text === '/start' || text.startsWith('/start ')) {
    return sendMessage(chatId,
      `👋 مرحباً بك في بوت *عرب تك سيرفر*!\n\n` +
      `📌 *قائمة الأوامر المتاحة:*\n` +
      `🔎 \`/track 1005\` - لتتبع طلب محدد برقمه\n` +
      `🔗 \`/unlink\` - لإلغاء ربط حسابك بهذا البوت\n\n` +
      `⚠️ *أول مرة هنا؟*\nلربط حسابك وتلقي كود التحقق (OTP) أو الطلب، أرسل لي أي من بيانات حسابك التالية:\n` +
      `1️⃣ *اسم المستخدم* (Username)\n` +
      `2️⃣ *البريد الإلكتروني* (Email)\n` +
      `3️⃣ *رقم الهاتف* (Phone)\n\n`
    );
  }

  if (text === '/id') {
    return sendMessage(chatId, `📌 *معرف الشات الخاص بك (Chat ID):*\n\n\`${chatId}\``);
  }

  // Require Linked Account for the rest
  const customer = await getQuery('SELECT * FROM customers WHERE telegram_chat_id = ?', [chatId]);

  if (text === '/orders') {
    if (!customer) return sendMessage(chatId, '❌ يجب ربط حسابك أولاً عن طريق إرسال إيميلك أو اسم المستخدم.');
    return handleMyOrdersCommand(chatId, customer);
  }
  
  if (text.startsWith('/track')) {
    if (!customer) return sendMessage(chatId, '❌ يجب ربط حسابك أولاً.');
    const parts = text.split(' ');
    if (parts.length < 2) return sendMessage(chatId, 'يرجى كتابة رقم الطلب بعد الأمر، مثال:\n`/track 1005`');
    return handleTrackCommand(chatId, customer, parts[1]);
  }

  // /order command has been disabled

  // Try linking account if not a command
  if (text && !text.startsWith('/')) {
    try {
      const normalizedText = text.toLowerCase();
      const phoneText = text.replace(/\s+/g, '');
      const linkingCust = await getQuery(
        'SELECT * FROM customers WHERE username = ? OR email = ? OR phone = ? OR phone = ?',
        [normalizedText, normalizedText, phoneText, `+${phoneText}`.replace('++', '+')]
      );

      if (linkingCust) {
        await runQuery('UPDATE customers SET telegram_chat_id = ? WHERE id = ?', [chatId, linkingCust.id]);
        return sendMessage(chatId,
          `✅ *تم ربط حسابك بنجاح!*\n\n👤 الحساب: *${linkingCust.username}*\n\nالآن يمكنك متابعة طلباتك بـ /orders 🚀`
        );
      } else {
        // If they just typed text but are already linked, and it's not a command/state, give a hint
        if (customer) {
          return sendMessage(chatId, 'لم أفهم هذا الأمر. استخدم /orders لمتابعة طلباتك.');
        } else {
          return sendMessage(chatId, `❌ لم يتم العثور على حساب يطابق: \`${text}\`\n\nتأكد من كتابة البيانات صحيحة للمطابقة.`);
        }
      }
    } catch (err) {
      console.error('[Telegram] Error linking customer:', err.message);
    }
  }
}

// ── Webhook / Polling Controls ────────────────────────────────────────────────
async function setWebhook(webhookUrl) {
  try {
    const res = await tgRequest('setWebhook', { url: webhookUrl });
    return res.ok;
  } catch (err) { return false; }
}

async function deleteWebhook() {
  try {
    const res = await tgRequest('deleteWebhook', {});
    return res.ok;
  } catch { return false; }
}

async function getBotInfo() {
  try { return await tgRequest('getMe', {}); } catch (err) { return { ok: false, error: err.message }; }
}

let lastUpdateId = 0;
let isPolling = false;
async function pollUpdates() {
  if (!isPolling) return;
  let hasMessages = false;
  try {
    const res = await tgRequest('getUpdates', { offset: lastUpdateId + 1, timeout: 10 });
    if (res.ok && res.result && res.result.length > 0) {
      hasMessages = true;
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        await processUpdate(update);
      }
    }
  } catch (err) {}
  
  if (isPolling) {
    if (hasMessages) {
      setImmediate(pollUpdates); // fetch next immediately
    } else {
      setTimeout(pollUpdates, 300); // short pause if empty
    }
  }
}
async function startPolling() {
  if (isPolling) return;
  console.log('[Telegram] Starting polling mode...');
  
  try {
    await tgRequest('setMyCommands', {
      commands: [
        { command: 'start', description: 'بدء البوت وعرض القائمة' },
        { command: 'track', description: 'تتبع طلب محدد' },
        { command: 'unlink', description: 'إلغاء ربط حسابك بهذا البوت' }
      ]
    });
    console.log('[Telegram] Bot menu commands updated.');
  } catch (err) {
    console.warn('[Telegram] Failed to set menu commands:', err.message);
  }

  isPolling = true;
  pollUpdates();
}
function stopPolling() {
  isPolling = false;
}

module.exports = {
  sendMessage,
  sendCustomerOtp,
  sendAdminOtp,
  getAdminChatIds,
  sendDocument,
  isTelegramConfigured,
  processUpdate,
  setWebhook,
  deleteWebhook,
  getBotInfo,
  startPolling,
  stopPolling,
  sendPhoto
};
