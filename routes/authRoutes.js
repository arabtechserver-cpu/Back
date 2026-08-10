const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getQuery, runQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const { getJwtSecret } = require('../utils/security');
const otpService = require('../utils/otpService');

// Admin Login (Protected with WhatsApp / Telegram / Gmail 2FA OTP if configured)
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  try {
    const user = await getQuery('SELECT * FROM users WHERE username = ?', [username]);

    if (!user) {
      return res.status(401).json({ message: 'بيانات الدخول غير صحيحة.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'بيانات الدخول غير صحيحة.' });
    }

    // Check if 2FA OTP enforcement is active
    try {
      const enforced = await otpService.isOtpEnforced();
      if (enforced) {
        const otpRes = await otpService.generateAndSendOtp(
          'admin_login',
          user.id,
          `🚨 *تنبيه أمان: محاولة تسجيل دخول للوحة التحكم (الداشبورد)*\n👤 *المستخدم:* ${user.username}`
        );
        if (otpRes && otpRes.success) {
          return res.json({
            requireOtp: true,
            userId: user.id,
            message: otpRes.message || 'تم إرسال كود التحقق (OTP) لإتمام تسجيل الدخول.'
          });
        } else {
          console.warn('[Admin Login] OTP delivery failed, falling back to direct login:', otpRes ? otpRes.message : '');
        }
      }
    } catch (otpErr) {
      console.warn('[Admin Login] OTP service exception:', otpErr.message);
    }

    // Standard login (if OTP is not enforced or failed to send)
    const token = jwt.sign(
      { id: user.id, username: user.username, role: 'admin' },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'تم تسجيل الدخول بنجاح.',
      token,
      user: { id: user.id, username: user.username }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم أثناء تسجيل الدخول.' });
  }
});

// POST /verify-login-otp
router.post('/verify-login-otp', async (req, res) => {
  const { userId, username, code, otp_code } = req.body;
  const actualCode = code || otp_code;
  let actualUserId = userId;

  try {
    if (!actualUserId && username) {
      const userRow = await getQuery('SELECT id FROM users WHERE username = ?', [username]);
      if (userRow) actualUserId = userRow.id;
    }
    if (!actualUserId && !username) {
      actualUserId = 1; // Default admin id fallback
    }

    if (!actualCode) {
      return res.status(400).json({ message: 'يرجى إدخال كود التحقق للمتابعة.' });
    }

    const valid = otpService.verifyAndConsumeOtp(actualCode, 'admin_login', actualUserId);
    if (!valid) {
      return res.status(403).json({ message: 'كود التحقق (OTP) غير صحيح أو منتهي الصلاحية!' });
    }

    const user = await getQuery('SELECT * FROM users WHERE id = ?', [actualUserId]);
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: 'admin' },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'تم التحقق من الكود بنجاح وتسجيل الدخول للداشبورد.',
      token,
      user: { id: user.id, username: user.username }
    });
  } catch (error) {
    console.error('Verify login OTP error:', error);
    return res.status(500).json({ message: 'حدث خطأ في الخادم أثناء التحقق من الكود.' });
  }
});

// Update admin credentials (Protected)
router.put('/update-credentials', authMiddleware, async (req, res) => {
  const { new_username, new_password } = req.body;
  const adminId = req.user.id;

  if (!new_username && !new_password) {
    return res.status(400).json({ message: 'يرجى إدخال اسم المستخدم أو كلمة المرور الجديدة.' });
  }

  try {
    if (new_username) {
      const duplicate = await getQuery('SELECT * FROM users WHERE username = ?', [new_username]);
      if (duplicate && Number(duplicate.id) !== Number(adminId)) {
        return res.status(400).json({ message: 'اسم المستخدم هذا مستخدم بالفعل.' });
      }
      await runQuery('UPDATE users SET username = ? WHERE id = ?', [new_username, adminId]);
    }

    if (new_password) {
      if (new_password.length < 6) {
        return res.status(400).json({ message: 'يجب أن تكون كلمة المرور 6 أحرف على الأقل.' });
      }
      const hashed = await bcrypt.hash(new_password, 10);
      await runQuery('UPDATE users SET password = ? WHERE id = ?', [hashed, adminId]);
    }

    res.json({ message: 'تم تحديث بيانات المسؤول بنجاح.' });
  } catch (error) {
    console.error('Update credentials error:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم أثناء تحديث البيانات.' });
  }
});

module.exports = router;
