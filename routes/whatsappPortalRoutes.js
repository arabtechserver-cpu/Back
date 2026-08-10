/**
 * Dedicated WhatsApp Portal Protection Routes
 * Manages double-security access (Portal Password + Fresh OTP) to the standalone WhatsApp QR & Management page.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const { getQuery, runQuery } = require('../db');
const otpService = require('../utils/otpService');
const { getJwtSecret } = require('../utils/security');

/**
 * Helper to check the portal password against stored setting or admin password
 */
async function checkPortalPassword(inputPassword, adminUserId) {
  if (!inputPassword) return false;

  // Check if a dedicated portal password setting exists
  const portalSet = await getQuery('SELECT value FROM settings WHERE key = ?', ['whatsapp_portal_password']);
  if (portalSet && portalSet.value) {
    if (portalSet.value === inputPassword) {
      return true;
    }
    // Also try bcrypt compare in case it was stored hashed
    try {
      const match = await bcrypt.compare(inputPassword, portalSet.value);
      if (match) return true;
    } catch {}
  }

  // Fallback: check against admin user login password
  const adminUser = await getQuery('SELECT password FROM users WHERE id = ?', [adminUserId]);
  if (adminUser && adminUser.password) {
    try {
      const match = await bcrypt.compare(inputPassword, adminUser.password);
      if (match) return true;
    } catch {}
    if (adminUser.password === inputPassword) return true;
  }

  return false;
}

// POST /api/whatsapp-portal/request-access
router.post('/request-access', authMiddleware, async (req, res) => {
  const { password } = req.body;

  try {
    const isPassValid = await checkPortalPassword(password, req.user.id);
    if (!isPassValid) {
      return res.status(401).json({ success: false, message: 'كلمة مرور الدخول لصفحة الواتساب غير صحيحة.' });
    }

    // Check if WhatsApp OTP is enforced
    const enforced = await otpService.isOtpEnforced();
    if (!enforced) {
      // Generate portal token directly if QR not scanned / no numbers yet
      const portalToken = jwt.sign(
        { id: req.user.id, username: req.user.username, role: 'admin', portalAccess: true },
        getJwtSecret(),
        { expiresIn: '60m' }
      );
      return res.json({
        success: true,
        requireOtp: false,
        portalToken,
        message: 'تم التحقق من كلمة المرور واجتياز كود الـ OTP (نظام إشعارات الواتساب غير متصل حالياً أو لا توجد أرقام مسجلة).'
      });
    }

    // Send WhatsApp OTP
    const otpRes = await otpService.generateAndSendOtp(
      'whatsapp_portal_access',
      req.user.id,
      '⚠️ *تنبيه أمان عالٍ: محاولة فتح صفحة مسح اليو آر وإدارة أرقام الواتساب المنفصلة.*'
    );

    if (!otpRes.success) {
      return res.status(500).json({ success: false, message: otpRes.message });
    }

    res.json({
      success: true,
      requireOtp: true,
      message: 'تم التحقق من كلمة المرور وإرسال كود التحقق (OTP) الجديد إلى أرقام الواتساب.'
    });
  } catch (error) {
    console.error('Portal request-access error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء طلب الدخول للصفحة.' });
  }
});

// POST /api/whatsapp-portal/verify-access
router.post('/verify-access', authMiddleware, async (req, res) => {
  const { code } = req.body;

  try {
    const valid = otpService.verifyAndConsumeOtp(code, 'whatsapp_portal_access', req.user.id);
    if (!valid) {
      return res.status(403).json({ success: false, message: 'كود التحقق (OTP) غير صحيح أو منتهي الصلاحية!' });
    }

    const portalToken = jwt.sign(
      { id: req.user.id, username: req.user.username, role: 'admin', portalAccess: true },
      getJwtSecret(),
      { expiresIn: '60m' }
    );

    res.json({
      success: true,
      portalToken,
      message: 'تم التحقق من كود الـ OTP بنجاح. تم فتح صفحة الإدارة.'
    });
  } catch (error) {
    console.error('Portal verify-access error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء التحقق من كود الـ OTP.' });
  }
});

// PUT /api/whatsapp-portal/change-password
router.put('/change-password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ success: false, message: 'يجب أن تكون كلمة المرور الجديدة 4 أحرف أو أرقام على الأقل.' });
  }

  try {
    // Verify current password first (if setting exists)
    const portalSet = await getQuery('SELECT value FROM settings WHERE key = ?', ['whatsapp_portal_password']);
    if (portalSet && portalSet.value && current_password) {
      if (portalSet.value !== current_password) {
        return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة.' });
      }
    }

    // Save new password in settings
    const existing = await getQuery('SELECT * FROM settings WHERE key = ?', ['whatsapp_portal_password']);
    if (!existing) {
      await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['whatsapp_portal_password', new_password]);
    } else {
      await runQuery('UPDATE settings SET value = ? WHERE key = ?', [new_password, 'whatsapp_portal_password']);
    }

    res.json({ success: true, message: '✅ تم تغيير وتحديث باسورد صفحة الواتساب المخصصة بنجاح.' });
  } catch (error) {
    console.error('Change portal password error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء تغيير كلمة المرور.' });
  }
});

module.exports = router;
