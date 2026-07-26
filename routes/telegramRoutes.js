/**
 * Telegram Bot Webhook & Management Routes
 *
 * POST /api/telegram/webhook          — receives updates from Telegram (public, no auth)
 * GET  /api/telegram/status           — bot status (admin only)
 * POST /api/telegram/set-webhook      — set webhook URL (admin only)
 * GET  /api/telegram/admin-ids        — get stored admin chat IDs (admin only)
 * POST /api/telegram/test             — send a test message to admin chat IDs (admin only)
 */

'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const telegram = require('../utils/telegramService');
const { runQuery, getQuery } = require('../db');

// POST /api/telegram/webhook — Telegram sends updates here (no auth needed, Telegram calls this)
router.post('/webhook', async (req, res) => {
  // Acknowledge immediately so Telegram doesn't retry
  res.sendStatus(200);

  try {
    await telegram.processUpdate(req.body);
  } catch (err) {
    console.error('[Telegram Webhook] Processing error:', err.message);
  }
});

// GET /api/telegram/status — admin: check bot info and config
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const botInfo = await telegram.getBotInfo();
    const configured = await telegram.isTelegramConfigured();
    const adminIds = await telegram.getAdminChatIds();

    res.json({
      ok: botInfo.ok,
      bot: botInfo.result || null,
      configured,
      admin_chat_ids: adminIds,
      message: botInfo.ok
        ? `البوت يعمل: @${botInfo.result.username}`
        : 'البوت غير متصل أو التوكن خاطئ'
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// POST /api/telegram/set-webhook — admin: configure webhook URL
router.post('/set-webhook', authMiddleware, async (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) {
    return res.status(400).json({ success: false, message: 'يرجى إرسال webhook_url.' });
  }
  const ok = await telegram.setWebhook(webhook_url);
  res.json({ success: ok, message: ok ? '✅ تم تعيين الـ Webhook بنجاح.' : '❌ فشل تعيين الـ Webhook.' });
});

// POST /api/telegram/save-admin-ids — admin: save admin Telegram chat IDs
router.post('/save-admin-ids', authMiddleware, async (req, res) => {
  let { chat_ids } = req.body;
  if (!chat_ids) return res.status(400).json({ success: false, message: 'يرجى إرسال chat_ids.' });

  // Accept string "123,456" or array
  if (typeof chat_ids === 'string') {
    chat_ids = chat_ids.split(',').map(s => s.trim()).filter(Boolean);
  }

  try {
    const value = JSON.stringify(chat_ids);
    const existing = await getQuery("SELECT value FROM settings WHERE key = 'telegram_admin_chat_ids'");
    if (existing) {
      await runQuery("UPDATE settings SET value = ? WHERE key = 'telegram_admin_chat_ids'", [value]);
    } else {
      await runQuery("INSERT INTO settings (key, value) VALUES ('telegram_admin_chat_ids', ?)", [value]);
    }
    res.json({ success: true, message: '✅ تم حفظ معرفات المسؤولين في تيليجرام بنجاح.', chat_ids });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/telegram/test — admin: send a test message to configured admin chat IDs
router.post('/test', authMiddleware, async (req, res) => {
  const adminIds = await telegram.getAdminChatIds();
  if (adminIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'لا توجد معرفات Telegram مسؤول مسجلة. أضف chat_ids أولاً.'
    });
  }

  const results = [];
  for (const chatId of adminIds) {
    const ok = await telegram.sendMessage(
      String(chatId),
      '✅ *اختبار بوت عرب تك سيرفر*\n\nالبوت يعمل بشكل صحيح وجاهز لإرسال كودات التحقق (OTP) والإشعارات! 🚀'
    );
    results.push({ chatId, ok });
  }

  res.json({
    success: results.some(r => r.ok),
    results,
    message: results.some(r => r.ok)
      ? '✅ تم إرسال رسالة الاختبار بنجاح.'
      : '❌ فشل إرسال رسالة الاختبار. تأكد من chat_ids والبوت.'
  });
});

module.exports = router;
