const express = require('express');
const router = express.Router();
const { runQuery, allQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const { saveImage } = require('../utils/imageSaver');
const bcrypt = require('bcryptjs');

function parseSetting(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function upsertSetting(key, value) {
  const existing = await allQuery('SELECT * FROM settings WHERE key = ?', [key]);
  if (existing.length === 0) {
    await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
  } else {
    await runQuery('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  }
}

function stripInlinePaymentLogos(paymentMethods) {
  if (!Array.isArray(paymentMethods)) return [];

  return paymentMethods.map((method) => {
    if (!method || typeof method !== 'object') return method;

    const logo = typeof method.logo === 'string' ? method.logo : '';
    if (!logo.startsWith('data:image')) return method;

    return {
      ...method,
      logo: ''
    };
  });
}

async function normalizePaymentMethodImages(paymentMethods) {
  if (!Array.isArray(paymentMethods)) return paymentMethods;

  return Promise.all(paymentMethods.map(async (method) => {
    if (!method || typeof method !== 'object') return method;

    const nextMethod = { ...method };
    if (typeof nextMethod.logo === 'string' && nextMethod.logo.startsWith('data:image')) {
      nextMethod.logo = await saveImage(nextMethod.logo);
    }
    if (typeof nextMethod.image === 'string' && nextMethod.image.startsWith('data:image')) {
      nextMethod.image = await saveImage(nextMethod.image);
    }

    return nextMethod;
  }));
}

// ── Auto-convert existing images to WebP ─────────────────────────────────────
router.post('/auto-convert-images', authMiddleware, async (req, res) => {
  try {
    const { runMigration } = require('../convert_images');
    const result = await runMigration();
    res.json({ message: 'تم فحص وتحويل الصور بنجاح.', details: result });
  } catch (err) {
    console.error('Image conversion error:', err);
    res.status(500).json({ message: 'حدث خطأ أثناء تحويل الصور.' });
  }
});

// Private settings are intentionally separated from the public storefront response.
router.get('/admin', authMiddleware, async (req, res) => {
  try {
    const rows = await allQuery('SELECT * FROM settings');
    const settings = Object.fromEntries(rows.map(item => [item.key, item.value]));

    res.set('Cache-Control', 'no-store, max-age=0');
    res.json({
      site_name: settings.site_name || 'SK-unlocker',
      site_logo: settings.site_logo || '/logo.jpg',
      site_favicon: settings.site_favicon || '/favicon.png',
      payment_methods: parseSetting(settings.payment_methods, []),
      supported_currencies: parseSetting(settings.supported_currencies, ['USD', 'USDT']),
      exchange_rates: parseSetting(settings.exchange_rates, { USD: 50, USDT: 51 }),
      base_currency: settings.base_currency || 'USD',
      home_hero_title: settings.home_hero_title || 'جميع الخدمات',
      home_hero_subtitle: settings.home_hero_subtitle || 'اختر الخدمة التي تناسب احتياجك من بين مجموعة واسعة من الخدمات الاحترافية الموثوقة',
      hide_wallet_payment: settings.hide_wallet_payment === 'true',
      whatsapp_numbers: parseSetting(settings.whatsapp_numbers, []),
      email_user: settings.email_user || '',
      email_pass_configured: Boolean(settings.email_pass),
      whatsapp_portal_password_configured: Boolean(settings.whatsapp_portal_password),
      global_markup_percent: parseFloat(settings.global_markup_percent) || 0,
      api_auto_submit: settings.api_auto_submit === undefined ? false : settings.api_auto_submit === 'true',
      announcement_text: settings.announcement_text || '',
      home_stats: settings.home_stats || '[]',
      featured_sections: parseSetting(settings.featured_sections, []),
      services_menu_placements: parseSetting(settings.services_menu_placements, { desktop: true, mobile: true, footer: true })
    });
  } catch (error) {
    console.error('Fetch private settings error:', error);
    res.status(500).json({ message: 'Unable to fetch private settings.' });
  }
});

// Lightweight public settings for SEO metadata and build-time rendering.
router.get('/metadata', async (req, res) => {
  try {
    const settingsList = await allQuery(
      "SELECT key, value FROM settings WHERE key IN ('site_name', 'site_logo', 'site_favicon', 'base_currency', 'home_hero_title', 'home_hero_subtitle')"
    );
    const settings = {};
    settingsList.forEach(item => {
      settings[item.key] = item.value;
    });

    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json({
      site_name: settings.site_name || 'SK-unlocker',
      site_logo: settings.site_logo || '/logo.jpg',
      site_favicon: settings.site_favicon || '/favicon.png',
      base_currency: settings.base_currency || 'USD',
    });
  } catch (error) {
    console.error('Fetch metadata settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب إعدادات الميتاداتا.' });
  }
});

// Get settings
router.get('/', async (req, res) => {
  try {
    const settingsList = await allQuery('SELECT * FROM settings');
    const settings = {};
    settingsList.forEach(item => {
      settings[item.key] = item.value;
    });

    let paymentMethods = [];
    if (settings.payment_methods) {
      try {
        paymentMethods = JSON.parse(settings.payment_methods);
      } catch (e) {
        console.error("Error parsing payment_methods settings:", e);
      }
    }
    if (!paymentMethods || paymentMethods.length === 0) {
      paymentMethods = [
        {
          id: "1",
          name: "تحويل فودافون كاش",
          value: "01026785879",
          type: "vodafone",
          description: "بعد التحويل اكتب الرقم الذي تم التحويل منه حتى يظهر للأدمن."
        }
      ];
    }

    let supportedCurrencies = ["USD", "USDT"];
    if (settings.supported_currencies) {
      try {
        supportedCurrencies = JSON.parse(settings.supported_currencies);
      } catch (e) {
        console.error("Error parsing supported_currencies settings:", e);
      }
    }

    let exchangeRates = { "USD": 50, "USDT": 51 };
    if (settings.exchange_rates) {
      try {
        exchangeRates = JSON.parse(settings.exchange_rates);
      } catch (e) {
        console.error("Error parsing exchange_rates settings:", e);
      }
    }

    let whatsappNumbers = [];
    if (settings.whatsapp_numbers) {
      try {
        whatsappNumbers = JSON.parse(settings.whatsapp_numbers);
      } catch (e) {
        console.error("Error parsing whatsapp_numbers settings:", e);
      }
    }

    let featuredSections = [];
    if (settings.featured_sections) {
      try {
        featuredSections = JSON.parse(settings.featured_sections);
      } catch (e) {
        console.error('Error parsing featured_sections settings:', e);
      }
    }

    res.json({
      announcement_text: settings.announcement_text || '🟢 واتساب الإدارة 1: +1 (672) 897-2935 | 🟢 واتساب الإدارة 2: +249 12 366 7227',
      site_name: settings.site_name || 'SK-unlocker',
      site_logo: settings.site_logo || '/logo.jpg',
      site_favicon: settings.site_favicon || '/favicon.png',
      payment_methods: stripInlinePaymentLogos(paymentMethods),
      supported_currencies: supportedCurrencies,
      exchange_rates: exchangeRates,
      base_currency: settings.base_currency || 'USD',
      hide_wallet_payment: settings.hide_wallet_payment === 'true',
      whatsapp_numbers: whatsappNumbers,
      home_stats: settings.home_stats || JSON.stringify([
        { id: 1, label: 'مستخدم نشط', value: '10K+', icon: '👥' },
        { id: 2, label: 'طلب ناجح', value: '50K+', icon: '✅' },
        { id: 3, label: 'خدمة متوفرة', value: '100+', icon: '⚡' },
        { id: 4, label: 'دعم فني', value: '24/7', icon: '🎧' }
      ]),
      featured_sections: featuredSections,
      services_menu_placements: parseSetting(settings.services_menu_placements, { desktop: true, mobile: true, footer: true })
    });
  } catch (error) {
    console.error('Fetch settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الإعدادات.' });
  }
});

// ── Update settings (Admin) ──────────────────────────────────────────────────
router.put('/', authMiddleware, async (req, res) => {
  try {
    const { 
      site_name, 
      site_logo,
      site_favicon,
      announcement_text, 
      payment_methods, 
      supported_currencies, 
      exchange_rates,
      base_currency,
      hide_wallet_payment,
      api_auto_submit,
      whatsapp_numbers,
      whatsapp_portal_password,
      email_user,
      email_pass,
      home_stats,
      featured_sections,
      global_markup_percent,
      services_menu_placements
    } = req.body;

    if (site_name) {
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['site_name']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['site_name', site_name]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [site_name, 'site_name']);
      }
    }

    if (site_logo !== undefined) {
      const logoValue = await saveImage(site_logo);
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['site_logo']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['site_logo', logoValue || '/logo.jpg']);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [logoValue || '/logo.jpg', 'site_logo']);
      }
    }

    if (site_favicon !== undefined) {
      const faviconValue = await saveImage(site_favicon);
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['site_favicon']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['site_favicon', faviconValue || '/favicon.png']);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [faviconValue || '/favicon.png', 'site_favicon']);
      }
    }

    if (base_currency) {
      await upsertSetting('base_currency', base_currency);
    }

    if (supported_currencies !== undefined) {
      const currencies = Array.isArray(supported_currencies)
        ? supported_currencies.filter(Boolean).map((currency) => String(currency).trim().toUpperCase())
        : parseSetting(supported_currencies, []);
      await upsertSetting('supported_currencies', JSON.stringify(currencies));
    }

    if (exchange_rates !== undefined) {
      const rates = typeof exchange_rates === 'string'
        ? exchange_rates
        : JSON.stringify(exchange_rates || {});
      await upsertSetting('exchange_rates', rates);
    }

    if (hide_wallet_payment !== undefined) {
      const hideVal = hide_wallet_payment ? 'true' : 'false';
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['hide_wallet_payment']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['hide_wallet_payment', hideVal]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [hideVal, 'hide_wallet_payment']);
      }
    }

    if (whatsapp_numbers !== undefined) {
      const numsStr = typeof whatsapp_numbers === 'string' ? whatsapp_numbers : JSON.stringify(whatsapp_numbers);
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['whatsapp_numbers']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['whatsapp_numbers', numsStr]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [numsStr, 'whatsapp_numbers']);
      }
    }

    if (whatsapp_portal_password !== undefined && String(whatsapp_portal_password).trim()) {
      const hashedPortalPassword = await bcrypt.hash(String(whatsapp_portal_password).trim(), 12);
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['whatsapp_portal_password']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['whatsapp_portal_password', hashedPortalPassword]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [hashedPortalPassword, 'whatsapp_portal_password']);
      }
    }

    if (email_user !== undefined) {
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['email_user']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['email_user', email_user.trim()]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [email_user.trim(), 'email_user']);
      }
    }

    if (email_pass !== undefined && String(email_pass).trim()) {
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['email_pass']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['email_pass', email_pass.trim()]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [email_pass.trim(), 'email_pass']);
      }
    }

    if (global_markup_percent !== undefined) {
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['global_markup_percent']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['global_markup_percent', String(global_markup_percent)]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [String(global_markup_percent), 'global_markup_percent']);
      }
    }

    if (api_auto_submit !== undefined) {
      const autoVal = api_auto_submit ? 'true' : 'false';
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['api_auto_submit']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['api_auto_submit', autoVal]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [autoVal, 'api_auto_submit']);
      }
    }

    if (announcement_text !== undefined) {
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['announcement_text']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['announcement_text', announcement_text]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [announcement_text, 'announcement_text']);
      }
    }

    if (home_stats !== undefined) {
      const statsStr = typeof home_stats === 'string' ? home_stats : JSON.stringify(home_stats);
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['home_stats']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['home_stats', statsStr]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [statsStr, 'home_stats']);
      }
    }

    if (featured_sections !== undefined) {
      const sectionsStr = typeof featured_sections === 'string' ? featured_sections : JSON.stringify(featured_sections);
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['featured_sections']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['featured_sections', sectionsStr]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [sectionsStr, 'featured_sections']);
      }
    }

    if (services_menu_placements !== undefined) {
      const placements = typeof services_menu_placements === 'string'
        ? services_menu_placements
        : JSON.stringify({
            desktop: services_menu_placements?.desktop !== false,
            mobile: services_menu_placements?.mobile !== false,
            footer: services_menu_placements?.footer === true
          });
      await upsertSetting('services_menu_placements', placements);
    }

    if (payment_methods !== undefined) {
      const normalizedPaymentMethods = typeof payment_methods === 'string'
        ? payment_methods
        : await normalizePaymentMethodImages(payment_methods);
      const methodsStr = typeof normalizedPaymentMethods === 'string'
        ? normalizedPaymentMethods
        : JSON.stringify(normalizedPaymentMethods);
      await upsertSetting('payment_methods', methodsStr);
    }

    res.json({ message: 'تم تحديث الإعدادات بنجاح.' });
    if (payment_methods !== undefined) {
      const normalizedPaymentMethods = typeof payment_methods === 'string'
        ? payment_methods
        : await normalizePaymentMethodImages(payment_methods);
      const methodsStr = typeof normalizedPaymentMethods === 'string'
        ? normalizedPaymentMethods
        : JSON.stringify(normalizedPaymentMethods);
      await upsertSetting('payment_methods', methodsStr);
    }

    if (payment_methods !== undefined) {
      const normalizedPaymentMethods = typeof payment_methods === 'string'
        ? payment_methods
        : await normalizePaymentMethodImages(payment_methods);
      const methodsStr = typeof normalizedPaymentMethods === 'string'
        ? normalizedPaymentMethods
        : JSON.stringify(normalizedPaymentMethods);
      const existing = await allQuery('SELECT * FROM settings WHERE key = ?', ['payment_methods']);
      if (existing.length === 0) {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', ['payment_methods', methodsStr]);
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [methodsStr, 'payment_methods']);
      }
    }
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث الإعدادات.' });
  }
});

module.exports = router;
