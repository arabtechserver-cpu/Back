/**
 * High Security OTP Service — Telegram + Gmail Gateway
 * Generates fresh 6-digit OTP codes every single time.
 * Protects: Dashboard Login, Portal Access, and Deletion Operations.
 */

'use strict';

const { getQuery, allQuery } = require('../db');
const telegram = require('./telegramService');

// In-memory store for active OTPs: key -> { code, action, targetId, expiresAt }
const activeOtps = new Map();

// Clean up expired OTPs periodically (every 60 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of activeOtps.entries()) {
    if (now > item.expiresAt) {
      activeOtps.delete(key);
    }
  }
}, 60000);

/**
 * Generate a fresh 6-digit OTP code
 */
function generateRandomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Check if Gmail SMTP sending is configured in the database settings
 */
async function isGmailConfigured() {
  try {
    const userRow = await getQuery("SELECT value FROM settings WHERE key = 'email_user'");
    const passRow = await getQuery("SELECT value FROM settings WHERE key = 'email_pass'");
    return !!(userRow && userRow.value && passRow && passRow.value);
  } catch (err) {
    return false;
  }
}

/**
 * Check if OTP enforcement is active (Telegram admin chat IDs set OR Gmail configured)
 */
async function isOtpEnforced() {
  const telegramConfigured = await telegram.isTelegramConfigured();
  const gmailConfigured = await isGmailConfigured();
  return telegramConfigured || gmailConfigured;
}

/**
 * Request and send a new OTP code via Telegram (admin) and Gmail
 * @param {string} action - 'admin_login' | 'whatsapp_portal_access' | 'delete'
 * @param {string|number|null} targetId
 * @param {string} customMessage - Arabic alert text describing the action
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function generateAndSendOtp(action, targetId = null, customMessage = '') {
  const telegramConfigured = await telegram.isTelegramConfigured();
  const gmailConfigured = await isGmailConfigured();

  // If neither Telegram nor Gmail configured, bypass
  if (!telegramConfigured && !gmailConfigured) {
    console.warn(`[OTP Service] Neither Telegram nor Gmail configured. OTP enforcement bypassed for action: ${action}`);
    return {
      success: false,
      bypassed: true,
      message: 'نظام إشعارات تيليجرام والبريد غير مهيأ. يرجى تهيئة تيليجرام أو بريد Gmail في الإعدادات.',
    };
  }

  // Generate fresh one-time code
  const code = generateRandomCode();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  const key = `${action}_${targetId !== null && targetId !== undefined ? targetId : 'global'}`;
  activeOtps.set(key, {
    code,
    action,
    targetId: targetId !== null && targetId !== undefined ? String(targetId) : null,
    expiresAt,
  });

  let telegramSent = false;
  let gmailSent = false;

  // 1. Send via Telegram
  if (telegramConfigured) {
    try {
      telegramSent = await telegram.sendAdminOtp(code, action, customMessage);
      if (telegramSent) {
        console.log(`[OTP Service] Fresh OTP (${code}) sent via Telegram for action [${action}]`);
      } else {
        console.error('[OTP Service] Failed to send OTP via Telegram');
      }
    } catch (err) {
      console.error('[OTP Service] Exception while sending Telegram OTP:', err.message);
    }
  }

  // 2. Send via Gmail if configured
  if (gmailConfigured) {
    try {
      const emailService = require('./emailService');
      const adminEmailRow = await getQuery("SELECT value FROM settings WHERE key = 'email_user'");
      const adminEmail = adminEmailRow ? adminEmailRow.value : '';
      if (adminEmail) {
        gmailSent = await emailService.sendAdminOtpEmail(adminEmail, {
          code,
          action,
          customMessage,
        });
        if (gmailSent) {
          console.log(`[OTP Service] Fresh OTP (${code}) sent via Gmail to ${adminEmail} for action [${action}]`);
        }
      }
    } catch (err) {
      console.error('[OTP Service] Exception while sending Gmail OTP:', err.message);
    }
  }

  if (telegramSent || gmailSent) {
    const channels = [];
    if (telegramSent) channels.push('تيليجرام');
    if (gmailSent) channels.push('الجميل');
    return {
      success: true,
      message: `تم إرسال كود تحقق (OTP) جديد عبر ${channels.join(' و ')}.`,
    };
  } else {
    return {
      success: false,
      message: 'فشل إرسال كود التحقق عبر تيليجرام والجميل. يرجى مراجعة الإعدادات.',
    };
  }
}

/**
 * Verify and immediately CONSUME (burn) an OTP code (One-Time Use).
 */
function verifyAndConsumeOtp(inputCode, action, targetId = null) {
  if (!inputCode) return false;
  const cleanInput = String(inputCode).trim();

  const key = `${action}_${targetId !== null && targetId !== undefined ? targetId : 'global'}`;
  const stored = activeOtps.get(key);

  if (!stored) {
    // Also check for delete action with any targetId
    if (action === 'delete') {
      for (const [k, item] of activeOtps.entries()) {
        if (item.action === 'delete' && item.code === cleanInput && Date.now() <= item.expiresAt) {
          activeOtps.delete(k);
          return true;
        }
      }
    }
    return false;
  }

  if (Date.now() > stored.expiresAt) {
    activeOtps.delete(key);
    return false;
  }

  if (stored.code === cleanInput && stored.action === action) {
    activeOtps.delete(key); // burn immediately
    console.log(`[OTP Service] OTP verified & burned for action [${action}] target [${targetId || 'global'}]`);
    return true;
  }

  return false;
}

module.exports = {
  generateRandomCode,
  isOtpEnforced,
  generateAndSendOtp,
  verifyAndConsumeOtp,
};
