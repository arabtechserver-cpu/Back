/**
 * OTP API Routes — High Security Deletions & Verifications
 * Protected by Admin Auth Middleware.
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const otpService = require('../utils/otpService');

// POST /api/otp/request-delete-otp
router.post('/request-delete-otp', authMiddleware, async (req, res) => {
  const { actionType, targetId, targetName } = req.body;

  try {
    const enforced = await otpService.isOtpEnforced();
    if (!enforced) {
      return res.json({
        success: true,
        bypassed: true,
        message: 'نظام إشعارات الواتساب غير متصل أو لا توجد أرقام مسجلة. يمكنك إتمام الحذف مباشرة.'
      });
    }

    const customMessage = `⚠️ *تنبيه أمان عالٍ: طلب الموافقة على حذف عنصر من لوحة التحكم*\n` +
      `🗑️ *نوع العملية:* ${actionType || 'حذف عنصر'}\n` +
      `📌 *العنصر المستهدف:* ${targetName || targetId || 'غير محدد'}\n` +
      `👤 *بواسطة المسؤول:* ${req.user ? req.user.username : 'Admin'}`;

    const result = await otpService.generateAndSendOtp('delete', targetId || 'global', customMessage);
    if (!result.success) {
      return res.status(500).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      requireOtp: true,
      message: result.message
    });
  } catch (error) {
    console.error('Request delete OTP error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء طلب كود الـ OTP.' });
  }
});

// POST /api/otp/verify-delete-otp
router.post('/verify-delete-otp', authMiddleware, async (req, res) => {
  const { code, targetId } = req.body;

  try {
    const enforced = await otpService.isOtpEnforced();
    if (!enforced) {
      return res.json({ success: true, valid: true, bypassed: true });
    }

    const valid = otpService.verifyAndConsumeOtp(code, 'delete', targetId || 'global');
    if (!valid) {
      return res.status(403).json({ success: false, valid: false, message: 'كود التحقق (OTP) غير صحيح أو منتهي الصلاحية!' });
    }

    res.json({ success: true, valid: true, message: 'تم التحقق من الكود بنجاح.' });
  } catch (error) {
    console.error('Verify delete OTP error:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء التحقق من كود الـ OTP.' });
  }
});

module.exports = router;
