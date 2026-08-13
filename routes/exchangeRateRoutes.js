const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { allQuery, runQuery } = require('../db');
const authMiddleware = require('../middleware/auth');

const SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';
const FALLBACK_RATE = 600;
const CACHE_TTL_MS = 10 * 60 * 1000;
let liveCache = null;

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readExchangeSettings() {
  const rows = await allQuery(
    "SELECT key, value FROM settings WHERE key IN ('exchange_rates', 'sdg_exchange_mode', 'sdg_exchange_rate', 'sdg_exchange_updated_at')"
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function upsertSetting(key, value) {
  const existing = await allQuery('SELECT key FROM settings WHERE key = ?', [key]);
  if (existing.length === 0) {
    await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
  } else {
    await runQuery('UPDATE settings SET value = ? WHERE key = ?', [String(value), key]);
  }
}

async function persistRate(rate, updatedAt = new Date().toISOString()) {
  const settings = await readExchangeSettings();
  const exchangeRates = parseJson(settings.exchange_rates, {});
  exchangeRates.SDG = rate;
  await upsertSetting('exchange_rates', JSON.stringify(exchangeRates));
  await upsertSetting('sdg_exchange_rate', rate);
  await upsertSetting('sdg_exchange_updated_at', updatedAt);
  return { exchangeRates, updatedAt };
}

async function fetchLiveRate(force = false) {
  if (!force && liveCache && Date.now() - liveCache.fetchedAtMs < CACHE_TTL_MS) {
    return liveCache;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(SOURCE_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`Exchange API returned ${response.status}`);
    const data = await response.json();
    const rate = Number(data?.rates?.SDG);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('SDG rate was not returned');

    const fetchedAt = new Date().toISOString();
    liveCache = { rate, fetchedAt, source: SOURCE_URL, fetchedAtMs: Date.now() };
    await persistRate(rate, fetchedAt);
    return liveCache;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildRateResponse(force = false) {
  const settings = await readExchangeSettings();
  const mode = settings.sdg_exchange_mode === 'manual' ? 'manual' : 'auto';
  const storedRate = Number(settings.sdg_exchange_rate || parseJson(settings.exchange_rates, {}).SDG) || FALLBACK_RATE;

  if (mode === 'manual') {
    return {
      rate: storedRate,
      inverseRate: 1 / storedRate,
      mode,
      source: 'manual',
      updatedAt: settings.sdg_exchange_updated_at || null,
      sourceUrl: null,
      fallback: false
    };
  }

  try {
    const live = await fetchLiveRate(force);
    return {
      rate: live.rate,
      inverseRate: 1 / live.rate,
      mode,
      source: 'ExchangeRate-API Open Access',
      updatedAt: live.fetchedAt,
      sourceUrl: live.source,
      fallback: false
    };
  } catch (error) {
    console.warn('SDG exchange rate refresh failed:', error.message);
    return {
      rate: storedRate,
      inverseRate: 1 / storedRate,
      mode,
      source: 'saved fallback',
      updatedAt: settings.sdg_exchange_updated_at || null,
      sourceUrl: null,
      fallback: true
    };
  }
}

router.get('/sdg', async (req, res) => {
  try {
    const result = await buildRateResponse(false);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(result);
  } catch (error) {
    console.error('Get SDG exchange rate error:', error);
    res.status(500).json({ message: 'Failed to load the SDG exchange rate.' });
  }
});

router.post('/sdg/refresh', authMiddleware, async (req, res) => {
  try {
    liveCache = null;
    res.json(await buildRateResponse(true));
  } catch (error) {
    console.error('Refresh SDG exchange rate error:', error);
    res.status(502).json({ message: 'Unable to refresh the SDG exchange rate.' });
  }
});

router.put('/sdg', authMiddleware, async (req, res) => {
  const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';
  const rate = Number(req.body?.rate);

  if (mode === 'manual' && (!Number.isFinite(rate) || rate <= 0)) {
    return res.status(400).json({ message: 'A positive SDG rate is required for manual mode.' });
  }

  try {
    await upsertSetting('sdg_exchange_mode', mode);
    if (mode === 'manual') {
      await persistRate(rate);
    }
    liveCache = null;
    res.json(await buildRateResponse(false));
  } catch (error) {
    console.error('Save SDG exchange rate settings error:', error);
    res.status(500).json({ message: 'Failed to save SDG exchange rate settings.' });
  }
});

module.exports = router;
