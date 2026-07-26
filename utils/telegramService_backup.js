/**
 * Telegram Bot Service — عرب تك سيرفر
 * Sends OTP codes and notifications via Telegram Bot API.
 * Bot: @ArabTechOTPBot
 * Token: stored in env TELEGRAM_BOT_TOKEN or settings table
 *
 * HOW IT WORKS:
 * 1. Customer sends /start to @ArabTechOTPBot
 * 2. Bot asks them to send their username
 * 3. We look up their account and save their chat_id
 * 4. From then on, OTPs and notifications go to their Telegram
 */

'use strict';

const https = require('https');
const { getQuery, runQuery } = require('../db');

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902996463:AAE3zudjSRRGwYDHsbtSD_eg2SCYQM8NmjQ';
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Low-level HTTP helper ─────────────────────────────────────────────────────
function tgRequest(method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
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

// ── Send a plain text message ─────────────────────────────────────────────────
async function sendMessage(chatId, text, parseMode = 'Markdown') {
  if (!chatId || !text) return false;
  try {
    const res = await tgRequest('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
    if (res.ok) {
      console.log(`[Telegram] Message sent to chat_id ${chatId}`);
      return true;
    } else {
      console.error(`[Telegram] sendMessage failed to ${chatId}:`, res.description);
      return false;
    }
  } catch (err) {
    console.error(`[Telegram] sendMessage exception:`, err.message);
    return false;
  }
}

// ── Send OTP to a customer via their stored chat_id ───────────────────────────
async function sendCustomerOtp(customerId, code, username, actionLabel) {
  try {
    const row = await getQuery('SELECT telegram_chat_id FROM customers WHERE id = ?', [customerId]);
    if (!row || !row.telegram_chat_id) {
      console.warn(`[Telegram] Customer ${customerId} has no telegram_chat_id — skipping Telegram OTP`);
      return false;
    }
    const text =
      `🔐 *عرب تك سيرفر — ${actionLabel || 'تأكيد الهوية'}*\n\n` +
      `مرحباً بك يا *${username}*،\n` +
      `🔑 كود التحقق (OTP) الخاص بك هو:\n\n` +
      `\`${code}\`\n\n` +
      `⏱️ الكود صالح لمدة 10 دقائق ويستخدم لمرة واحدة.\n` +
      `🛡️ لا تشاركه مع أحد.`;
    return sendMessage(row.telegram_chat_id, text);
  } catch (err) {
    console.error('[Telegram] sendCustomerOtp error:', err.message);
    return false;
  }
}

// ── Send OTP to admin Telegram chat IDs stored in settings ────────────────────
async function sendAdminOtp(code, action, customMessage = '') {
  try {
    const row = await getQuery("SELECT value FROM settings WHERE key = 'telegram_admin_chat_ids'");
    if (!row || !row.value) {
      console.warn('[Telegram] No admin telegram_admin_chat_ids configured in settings.');
      return false;
    }
    let chatIds = [];
    try { chatIds = JSON.parse(row.value); } catch { chatIds = [row.value]; }
    if (!Array.isArray(chatIds) || chatIds.length === 0) return false;

    let actionText = 'إجراء أمان';
    if (action === 'admin_login') actionText = 'تسجيل دخول لوحة التحكم';
    else if (action === 'delete') actionText = 'تأكيد عملية حذف حساسة';
    else if (action === 'whatsapp_portal_access') actionText = 'الدخول لبوابة إدارة الواتساب';

    const text =
      `🔐 *كود تحقق أمان المسؤول (OTP)*\n\n` +
      (customMessage ? `${customMessage}\n\n` : '') +
      `⚡ *الإجراء:* ${actionText}\n` +
      `🔑 *كود التحقق:*\n\n\`${code}\`\n\n` +
      `⏱️ صالح لمدة 5 دقائق ويستخدم لمرة واحدة.\n` +
      `🛡️ *عرب تك سيرفر — نظام الحماية المتقدم*`;

    let anySent = false;
    for (const chatId of chatIds) {
      const ok = await sendMessage(String(chatId), text);
      if (ok) anySent = true;
    }
    return anySent;
  } catch (err) {
    console.error('[Telegram] sendAdminOtp error:', err.message);
    return false;
  }
}

// ── Get admin chat IDs from settings ─────────────────────────────────────────
async function getAdminChatIds() {
  try {
    const row = await getQuery("SELECT value FROM settings WHERE key = 'telegram_admin_chat_ids'");
    if (!row || !row.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

// ── Check if Telegram is configured (bot token present + admin chat IDs set) ──
async function isTelegramConfigured() {
  if (!BOT_TOKEN) return false;
  const ids = await getAdminChatIds();
  return ids.length > 0;
}

// ── Process an incoming Telegram update (webhook handler) ─────────────────────
// ── Process an incoming Telegram update (webhook handler / poller) ──────────────
// When a user sends /start or their username/email/phone, we try to link their account.
async function processUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const firstName = msg.from ? msg.from.first_name : 'صديق';

  console.log(`[Telegram] Received from chat_id ${chatId}: ${text}`);

  // /start command
  if (text === '/start' || text.startsWith('/start ')) {
    await sendMessage(chatId,
      `👋 مرحباً بك في بوت *عرب تك سيرفر*!\n\n` +
      `لربط حسابك وتلقي كود التحقق (OTP) عبر تيليجرام، أرسل لي أي من بيانات حسابك التالية:\n` +
      `1️⃣ *اسم المستخدم* (Username)\n` +
      `2️⃣ *البريد الإلكتروني* (Email)\n` +
      `3️⃣ *رقم الهاتف* (Phone)\n\n` +
      `📌 تأكد أن البيانات مطابقة تماماً لما هو مسجل في الموقع.`
    );
    return;
  }

  // /id command — returns the chat_id (useful for admin setup)
  if (text === '/id') {
    await sendMessage(chatId,
      `📌 *معرف الشات الخاص بك (Chat ID):*\n\n\`${chatId}\`\n\nأرسل هذا الرقم للمسؤول لإضافتك كمسؤول في الإشعارات.`
    );
    return;
  }

  // Try to match the text as a customer username, email, or phone
  if (text && !text.startsWith('/')) {
    try {
      // Normalize text for comparison
      const normalizedText = text.toLowerCase();
      // Phone numbers sometimes have spaces or + in front, let's also remove spaces just in case
      const phoneText = text.replace(/\s+/g, '');

      const customer = await getQuery(
        'SELECT * FROM customers WHERE username = ? OR email = ? OR phone = ? OR phone = ?',
        [normalizedText, normalizedText, phoneText, `+${phoneText}`.replace('++', '+')]
      );

      if (customer) {
        // Save the chat_id
        await runQuery('UPDATE customers SET telegram_chat_id = ? WHERE id = ?', [chatId, customer.id]);
        await sendMessage(chatId,
          `✅ *تم ربط حسابك بنجاح!*\n\n` +
          `👤 الحساب: *${customer.username}*\n` +
          `📱 ستصلك الآن كودات التحقق (OTP) عبر تيليجرام مباشرةً.\n\n` +
          `🛡️ *عرب تك سيرفر* — أمانك أولويتنا ❤️`
        );
        console.log(`[Telegram] Customer ${customer.username} (id: ${customer.id}) linked to chat_id ${chatId}`);
      } else {
        await sendMessage(chatId,
          `❌ لم يتم العثور على حساب يطابق: \`${text}\`\n\n` +
          `تأكد من كتابة (اسم المستخدم) أو (الإيميل) أو (رقم الهاتف) بشكل صحيح كما هو مسجل في الموقع، ثم أرسله مجدداً.`
        );
      }
    } catch (err) {
      console.error('[Telegram] Error linking customer:', err.message);
      await sendMessage(chatId, '⚠️ حدث خطأ أثناء ربط الحساب. يرجى المحاولة مجدداً.');
    }
  }
}

// ── Set webhook URL for the bot ───────────────────────────────────────────────
async function setWebhook(webhookUrl) {
  try {
    const res = await tgRequest('setWebhook', { url: webhookUrl });
    console.log('[Telegram] setWebhook result:', res.description || res.result);
    return res.ok;
  } catch (err) {
    console.error('[Telegram] setWebhook error:', err.message);
    return false;
  }
}

// ── Delete webhook (switch to polling mode) ───────────────────────────────────
async function deleteWebhook() {
  try {
    const res = await tgRequest('deleteWebhook', {});
    return res.ok;
  } catch { return false; }
}

// ── Get bot info ──────────────────────────────────────────────────────────────
async function getBotInfo() {
  try {
    return await tgRequest('getMe', {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Polling (For local testing or servers without webhooks) ───────────────────
let lastUpdateId = 0;
let isPolling = false;

async function pollUpdates() {
  if (!isPolling) return;
  try {
    const res = await tgRequest('getUpdates', { offset: lastUpdateId + 1, timeout: 10 });
    if (res.ok && res.result && res.result.length > 0) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        await processUpdate(update);
      }
    }
  } catch (err) {
    // ignore timeout errors
  }
  if (isPolling) {
    setTimeout(pollUpdates, 500); // Fast polling for instant replies
  }
}

function startPolling() {
  if (isPolling) return;
  console.log('[Telegram] Starting polling mode...');
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
  isTelegramConfigured,
  processUpdate,
  setWebhook,
  deleteWebhook,
  getBotInfo,
  startPolling,
  stopPolling
};
