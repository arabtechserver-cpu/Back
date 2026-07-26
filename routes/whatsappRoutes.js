/**
 * WhatsApp API Routes
 * Protected by admin auth middleware.
 *
 * GET  /api/whatsapp/status   — current connection status + QR (if waiting)
 * POST /api/whatsapp/start    — initialise / reconnect client
 * POST /api/whatsapp/logout   — destroy client & clear session
 * POST /api/whatsapp/send     — send test message
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const wa = require('../whatsapp');

// GET /api/whatsapp/status
router.get('/status', authMiddleware, (req, res) => {
  res.json({
    status: wa.getStatus(),
    qr: wa.getQR() || null
  });
});

// POST /api/whatsapp/start  — init or restart
router.post('/start', authMiddleware, (req, res) => {
  const currentStatus = wa.getStatus();
  if (currentStatus === 'ready') {
    return res.json({ message: 'الواتساب متصل بالفعل.', status: 'ready' });
  }
  if (currentStatus === 'qr' || currentStatus === 'loading') {
    return res.json({ message: 'جاري التهيئة — امسح QR إذا ظهر.', status: currentStatus });
  }

  wa.initWhatsApp();
  res.json({ message: 'تم بدء تهيئة الواتساب. انتظر ظهور QR Code.', status: 'loading' });
});

// POST /api/whatsapp/logout
router.post('/logout', authMiddleware, async (req, res) => {
  await wa.destroyClient();
  // Also delete the session folder so next start shows fresh QR
  try {
    const fs = require('fs');
    const path = require('path');
    const sessionPath = path.join(__dirname, '..', 'wa-session');
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[WhatsApp] Could not delete session folder:', e.message);
  }
  res.json({ message: 'تم قطع اتصال الواتساب بنجاح.' });
});

// POST /api/whatsapp/send  — send test or custom message
router.post('/send', authMiddleware, async (req, res) => {
  const { numbers, text } = req.body;
  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ message: 'يرجى إرسال قائمة أرقام صحيحة.' });
  }
  if (!text) {
    return res.status(400).json({ message: 'يرجى إرسال نص الرسالة.' });
  }
  try {
    const results = await wa.sendMessage(numbers, text);
    res.json({ message: 'تم إرسال الرسالة.', results });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
