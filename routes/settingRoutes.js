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

// Private settings are intentionally separated from the public storefront response.
router.get('/admin', authMiddleware, async (req, res) => {
  try {
    const rows = await allQuery('SELECT * FROM settings');
    const settings = Object.fromEntries(rows.map(item => [item.key, item.value]));

    res.set('Cache-Control', 'no-store, max-age=0');
    res.json({
      site_name: settings.site_name || 'Arab Tech Server',
      site_logo: settings.site_logo || '/logo.jpg',
      site_favicon: settings.site_favicon || '/favicon.png',
      payment_methods: parseSetting(settings.payment_methods, []),
      supported_currencies: parseSetting(settings.supported_currencies, ['USD', 'USDT']),
      exchange_rates: parseSetting(settings.exchange_rates, { USD: 50, USDT: 51 }),
      base_currency: settings.base_currency || 'USD',
      hide_wallet_payment: settings.hide_wallet_payment === 'true',
      whatsapp_numbers: parseSetting(settings.whatsapp_numbers, []),
      email_user: settings.email_user || '',
      email_pass_configured: Boolean(settings.email_pass),
      whatsapp_portal_password_configured: Boolean(settings.whatsapp_portal_password),
      global_markup_percent: parseFloat(settings.global_markup_percent) || 0,
      api_auto_submit: settings.api_auto_submit === undefined ? true : settings.api_auto_submit === 'true',
      announcement_text: settings.announcement_text || '',
      home_stats: settings.home_stats || '[]',
      featured_sections: parseSetting(settings.featured_sections, [])
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
      "SELECT key, value FROM settings WHERE key IN ('site_name', 'site_logo', 'site_favicon', 'base_currency')"
    );
    const settings = {};
    settingsList.forEach(item => {
      settings[item.key] = item.value;
    });

    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json({
      site_name: settings.site_name || 'عرب تك سيرفر',
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
      site_name: settings.site_name || 'عرب تك سيرفر',
      site_logo: settings.site_logo || '/logo.jpg',
      site_favicon: settings.site_favicon || '/favicon.png',
      payment_methods: paymentMethods,
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
      featured_sections: featuredSections
    });
  } catch (error) {
    console.error('Fetch settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الإعدادات.' });
      } else {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [base_currency, 'base_currency']);
      }
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

    res.json({ message: 'تم تحديث الإعدادات بنجاح.' });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث الإعدادات.' });
  }
});

// Test email endpoint
router.post('/test-email', authMiddleware, async (req, res) => {
  const { testEmail } = req.body;
  if (!testEmail) {
    return res.status(400).json({ message: 'يرجى إدخال البريد الإلكتروني المراد إرسال التجربة إليه.' });
  }
  try {
    const nodemailer = require('nodemailer');
    const settingsList = await allQuery("SELECT * FROM settings WHERE key IN ('email_user', 'email_pass', 'site_name')");
    const settings = {};
    settingsList.forEach(item => {
      settings[item.key] = item.value;
    });

    if (!settings.email_user || !settings.email_pass) {
      return res.status(400).json({ message: 'يرجى حفظ البريد الإلكتروني وكلمة مرور التطبيقات أولاً في الإعدادات.' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: settings.email_user,
        pass: settings.email_pass
      }
    });

    const siteName = settings.site_name || 'عرب تك سيرفر';

    const mailOptions = {
      from: `"${siteName}" <${settings.email_user}>`,
      to: testEmail,
      subject: `[${siteName}] 🚀 تجربة ربط البريد الإلكتروني (Gmail) ناجحة!`,
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 550px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 16px; overflow: hidden; border: 1px solid #334155; direction: rtl; text-align: right;">
          <div style="background: linear-gradient(135deg, #0284c7, #2563eb); padding: 25px 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px; color: #ffffff; font-weight: 800;">🚀 ${siteName}</h1>
            <p style="margin: 6px 0 0; font-size: 14px; color: #e2e8f0;">نظام إرسال الإشعارات والبريد الإلكتروني</p>
          </div>
          <div style="padding: 30px 25px;">
            <h2 style="color: #38bdf8; font-size: 20px; margin-top: 0; display: flex; align-items: center; gap: 8px;">
              <span>🎉 تجربة اتصال ناجحة بنسبة 100%!</span>
            </h2>
            <p style="font-size: 15px; line-height: 1.8; color: #cbd5e1; margin-bottom: 20px;">
              مرحباً بك! هذه رسالة تجريبية تؤكد أن بوابة ربط بريد Gmail (<strong>${settings.email_user}</strong>) تعمل بكفاءة عالية وبدون أي مشاكل.
            </p>
            <div style="background: #1e293b; padding: 18px; border-radius: 12px; border-right: 4px solid #10b981; margin-bottom: 25px;">
              <p style="margin: 0; font-size: 14px; color: #10b981; font-weight: bold;">
                ✓ تم التحقق من كلمة مرور التطبيقات (App Password) وأنظمة الأمان.
              </p>
            </div>
            <p style="font-size: 13px; color: #94a3b8; border-top: 1px solid #334155; padding-top: 15px; margin-bottom: 0;">
              يمكنك الآن الاعتماد على هذا البريد لإرسال أكواد التحقق (OTP) وإشعارات الطلبات وشحن المحفظة لجميع عملائك.
            </p>
          </div>
          <div style="background: #0b1120; padding: 15px; text-align: center; font-size: 12px; color: #64748b;">
            جميع الحقوق محفوظة &copy; ${new Date().getFullYear()} ${siteName}
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: 'تم إرسال الرسالة التجريبية بنجاح إلى ' + testEmail + '!' });
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ message: 'فشل الإرسال: ' + (error.message || 'تأكد من صحة كلمة مرور التطبيقات وأن الحساب يسمح بالاتصال.') });
  }
});

module.exports = router;
