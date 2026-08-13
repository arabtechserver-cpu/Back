const express = require('express');
const router = express.Router();
const { runQuery, allQuery } = require('../db');
const authMiddleware = require('../middleware/auth');

const ALLOWED_EVENTS = new Set([
  'home_view',
  'catalog_view',
  'service_view',
  'package_selected',
  'checkout_started',
  'login_required',
  'order_submitted',
  'order_completed',
]);

function safeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowedKeys = ['serviceId', 'packageId', 'paymentMethod', 'source', 'typeFilter', 'guest'];
  return allowedKeys.reduce((result, key) => {
    if (value[key] !== undefined && value[key] !== null) {
      result[key] = safeText(value[key], 120);
    }
    return result;
  }, {});
}

// Anonymous conversion events only. No email, phone, username or entered service data.
router.post('/events', async (req, res) => {
  const eventName = safeText(req.body?.eventName, 80);
  if (!ALLOWED_EVENTS.has(eventName)) {
    return res.status(400).json({ message: 'حدث غير صالح.' });
  }

  try {
    const metadata = sanitizeMetadata(req.body?.metadata);
    await runQuery(
      'INSERT INTO conversion_events (event_name, session_id, path, metadata) VALUES (?, ?, ?, ?)',
      [
        eventName,
        safeText(req.body?.sessionId, 100),
        safeText(req.body?.path, 500),
        JSON.stringify(metadata),
      ]
    );
    return res.status(202).json({ accepted: true });
  } catch (error) {
    console.error('Conversion event error:', error.message);
    return res.status(500).json({ message: 'تعذر تسجيل الحدث.' });
  }
});

router.get('/summary', authMiddleware, async (req, res) => {
  const requestedDays = Number(req.query.days);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

  try {
    const rows = await allQuery('SELECT * FROM conversion_events ORDER BY id DESC LIMIT 10000');
    const recentRows = (rows || []).filter((row) => {
      const timestamp = new Date(row.created_at).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    }).slice(0, 10000);

    const counts = Object.fromEntries([...ALLOWED_EVENTS].map((name) => [name, 0]));
    const sessions = new Set();
    const dailyMap = new Map();

    recentRows.forEach((row) => {
      if (counts[row.event_name] !== undefined) counts[row.event_name] += 1;
      if (row.session_id) sessions.add(row.session_id);
      const day = new Date(row.created_at).toISOString().slice(0, 10);
      const current = dailyMap.get(day) || { day, service_view: 0, checkout_started: 0, order_completed: 0 };
      if (current[row.event_name] !== undefined) current[row.event_name] += 1;
      dailyMap.set(day, current);
    });

    const percentage = (part, total) => total > 0 ? Number(((part / total) * 100).toFixed(1)) : 0;
    return res.json({
      days,
      uniqueSessions: sessions.size,
      counts,
      rates: {
        serviceToCheckout: percentage(counts.checkout_started, counts.service_view),
        checkoutToOrder: percentage(counts.order_completed, counts.checkout_started),
        serviceToOrder: percentage(counts.order_completed, counts.service_view),
      },
      daily: [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    });
  } catch (error) {
    console.error('Conversion summary error:', error.message);
    return res.status(500).json({ message: 'تعذر تحميل تقرير التحويلات.' });
  }
});

module.exports = router;
