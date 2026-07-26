/**
 * High Security Deletion OTP Middleware
 * Enforces one-time WhatsApp OTP confirmation before allowing any DELETE operation.
 */

const otpService = require('../utils/otpService');

async function deleteOtpAuth(req, res, next) {
  try {
    const enforced = await otpService.isOtpEnforced();
    if (!enforced) {
      // WhatsApp notifications not connected or no numbers set -> allow direct deletion
      return next();
    }

    const otpCode = req.headers['x-otp-code'] || req.body?.otp_code || req.query?.otp_code;
    const targetId = req.params?.id || req.body?.id || req.body?.targetId || 'global';

    if (!otpCode) {
      const result = await otpService.generateAndSendOtp(
        'delete',
        targetId,
        `⚠️ تنبيه أمان حساس: تم طلب حذف عنصر (ID: #${targetId}) من لوحة التحكم، يرجى إدخال الكود للتأكيد.`
      );
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: `🚨 فشل إرسال كود الأمان (OTP): ${result.message}`
        });
      }

      return res.status(403).json({
        success: false,
        requireOtp: true,
        message: '🚨 حماية أمان لوحة التحكم: تم إرسال كود تحقق (OTP) جديد الآن على رقم الواتساب أو البريد الخاص بك للموافقة على الحذف.'
      });
    }

    const valid = otpService.verifyAndConsumeOtp(otpCode, 'delete', targetId);
    if (!valid) {
      return res.status(403).json({
        success: false,
        requireOtp: true,
        message: '❌ كود التحقق (OTP) غير صحيح أو انتهت صلاحيته أو تم استخدامه بالفعل. يرجى طلب كود جديد للمحاولة.'
      });
    }

    // OTP verified and burned! Proceed with deletion.
    next();
  } catch (err) {
    console.error('[deleteOtpAuth] Error verifying delete OTP:', err);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم أثناء التحقق من أمان عملية الحذف.' });
  }
}

module.exports = deleteOtpAuth;
