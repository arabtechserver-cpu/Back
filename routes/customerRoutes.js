const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const deleteOtpAuth = require('../middleware/deleteOtpAuth');
const { getQuery, runQuery, allQuery } = require('../db');
const { getJwtSecret } = require('../utils/security');
const turnstileMiddleware = require('../middleware/turnstileMiddleware');

const telegram = require('../utils/telegramService');
const emailService = require('../utils/emailService');
const { allQuery: allQuerySettings } = require('../db');
const wa = require('../whatsapp');

// Database-backed store for customer OTPs during login & registration
async function setCustomerOtp(otpKey, data) {
  const expiresAt = data.expiresAt || (Date.now() + 10 * 60 * 1000);
  data.expiresAt = expiresAt;
  await runQuery('DELETE FROM customer_otps WHERE otp_key = ?', [otpKey]);
  await runQuery('INSERT INTO customer_otps (otp_key, data, expires_at) VALUES (?, ?, ?)', [otpKey, JSON.stringify(data), expiresAt]);
}

async function getCustomerOtp(otpKey) {
  const row = await getQuery('SELECT * FROM customer_otps WHERE otp_key = ?', [otpKey]);
  if (!row) return null;
  if (Date.now() > Number(row.expires_at)) {
    await deleteCustomerOtp(otpKey);
    return null;
  }
  return JSON.parse(row.data);
}

async function deleteCustomerOtp(otpKey) {
  await runQuery('DELETE FROM customer_otps WHERE otp_key = ?', [otpKey]);
}

setInterval(async () => {
  try {
    await runQuery('DELETE FROM customer_otps WHERE expires_at < ?', [Date.now()]);
  } catch (e) {}
}, 60000);

// Customer Auth Middleware
const customerAuth = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ message: 'يرجى تسجيل الدخول أولاً لمتابعة الطلبات.' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'التوكن غير متوفر.' });
    }

    const decoded = jwt.verify(token, getJwtSecret());
    req.customer = decoded; // { id, username }
    next();
  } catch (error) {
    return res.status(403).json({ message: 'جلسة العمل منتهية، يرجى تسجيل الدخول مجدداً.' });
  }
};

// Register Customer (Username, mandatory Gmail, optional phone number)
router.post('/register', turnstileMiddleware, async (req, res) => {
  const { username, email, password, phone } = req.body;

  if (!username || !email || !password || !phone) {
    return res.status(400).json({ message: 'اسم المستخدم، البريد الإلكتروني (الجميل)، كلمة المرور، ورقم الهاتف (الواتساب) مطلوبة.' });
  }

  const cleanUsername = username.trim();
  const cleanEmail = email.trim().toLowerCase();
  const userPhone = phone.trim();

  if (!userPhone) {
    return res.status(400).json({ message: 'يرجى إدخال رقم هاتف (واتساب) صالح.' });
  }

  if (cleanUsername.length < 3) {
    return res.status(400).json({ message: 'يجب أن يكون اسم المستخدم 3 أحرف على الأقل.' });
  }

  // Validate Gmail address
  const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
  if (!gmailRegex.test(cleanEmail)) {
    return res.status(400).json({ message: 'يجب إدخال بريد إلكتروني Gmail صحيح (ينتهي بـ @gmail.com).' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'يجب أن تكون كلمة المرور 6 أحرف على الأقل.' });
  }

  try {
    const existingUsername = await getQuery('SELECT * FROM customers WHERE username = ?', [cleanUsername]);
    if (existingUsername) {
      return res.status(400).json({ message: 'اسم المستخدم هذا مسجل بالفعل.' });
    }

    const existingEmail = await getQuery('SELECT * FROM customers WHERE email = ?', [cleanEmail]);
    if (existingEmail) {
      return res.status(400).json({ message: 'البريد الإلكتروني هذا مسجل بالفعل.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate 6-digit OTP code for verification before creating account
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const otpKey = `reg_${cleanUsername}_${Date.now()}`;

    await setCustomerOtp(otpKey, {
      code,
      type: 'register',
      username: cleanUsername,
      email: cleanEmail,
      password: hashedPassword,
      passwordPlain: password,
      phone: userPhone,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    console.log(`[Customer Auth OTP] Generated code [${code}] for registration of ${cleanUsername} (${cleanEmail} / ${userPhone})`);

    // 1. Send via Telegram if customer has linked their Telegram account
    try {
      // We look up by phone to find any customer that registered with this phone
      // Since this is registration, we send by phone number if a matching customer exists
      // (For new registrations, Telegram OTP will arrive after they link their account via /start)
      const existingByPhone = await getQuery('SELECT id, username, telegram_chat_id FROM customers WHERE phone = ?', [userPhone]);
      if (existingByPhone && existingByPhone.telegram_chat_id) {
        await telegram.sendCustomerOtp(existingByPhone.id, code, cleanUsername, 'تأكيد إنشاء الحساب');
      } else {
        console.log(`[Customer Auth OTP] No Telegram chat_id for phone ${userPhone} — skipping Telegram`);
      }
    } catch (e) {
      console.warn('[Customer Auth OTP] Telegram send failed:', e.message);
    }

    // 2. Send via WhatsApp
    if (userPhone) {
      try {
        const waMsg = `مرحباً بك في عرب تك سيرفر 🚀\n\nكود التحقق الخاص بك هو: *${code}*\nلإتمام إنشاء الحساب، يرجى إدخال هذا الكود.\n\n⚠️ الكود صالح لمدة 10 دقائق فقط.`;
        await wa.sendMessage([userPhone], waMsg);
      } catch (waErr) {
        console.warn('[Customer Auth OTP] WhatsApp send failed:', waErr.message);
      }
    }

    // 3. Send via Loops / Email
    try {
      await emailService.sendCustomerAuthOtpEmail(cleanEmail, {
        code,
        username: cleanUsername,
        actionLabel: 'إنشاء وتفعيل حسابك الجديد'
      });
    } catch (emailErr) {
      console.error(`[Customer Auth OTP] Registration email send FAILED to ${cleanEmail}:`, emailErr.message);
    }

    return res.status(200).json({
      requireOtp: true,
      otpKey,
      message: 'تم إرسال كود التحقق (OTP) إلى بريدك الجميل أو رقم الواتساب. يرجى إدخال الكود لإتمام إنشاء الحساب.',
      targetInfo: userPhone ? `واتساب (${userPhone}) والجميل (${cleanEmail})` : `الجميل (${cleanEmail})`
    });
  } catch (error) {
    console.error('Customer registration error:', error);
    if (error.message && error.message.includes('UNIQUE')) {
      return res.status(400).json({ message: 'اسم المستخدم أو البريد الإلكتروني مسجل بالفعل.' });
    }
    return res.status(500).json({ message: 'حدث خطأ أثناء إنشاء الحساب.' });
  }
});


// Login Customer (Supports Gmail / Username with OTP verification)
router.post('/login', turnstileMiddleware, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'البريد الإلكتروني/اسم المستخدم وكلمة المرور مطلوبان.' });
  }

  const trimmedUsername = username.trim();

  try {
    let customer = await getQuery('SELECT * FROM customers WHERE username = ? OR email = ?', [trimmedUsername, trimmedUsername.toLowerCase()]);

    if (!customer) {
      return res.status(401).json({ message: 'البريد الإلكتروني أو اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }

    let isMatch = false;
    if (customer.password && (customer.password.startsWith('$2a$') || customer.password.startsWith('$2b$'))) {
      isMatch = await bcrypt.compare(password, customer.password);
    } else {
      isMatch = (password === customer.password);
    }
    if (!isMatch) {
      return res.status(401).json({ message: 'البريد الإلكتروني أو اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }

    // Generate 6-digit OTP for login
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const otpKey = `login_${customer.id}_${Date.now()}`;

    await setCustomerOtp(otpKey, {
      code,
      type: 'login',
      customerId: customer.id,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    console.log(`[Customer Auth OTP] Generated code [${code}] for login of ${customer.username} (${customer.email} / ${customer.phone})`);

    // 1. Send via Telegram if customer has linked their Telegram account
    try {
      await telegram.sendCustomerOtp(customer.id, code, customer.username, 'تأكيد تسجيل الدخول');
    } catch (e) {
      console.warn('[Customer Auth OTP] Telegram send failed:', e.message);
    }

    // 2. Send via WhatsApp
    if (customer.phone) {
      try {
        const waMsg = `مرحباً بك في عرب تك سيرفر 🚀\n\nكود التحقق الخاص بك هو: *${code}*\nلإتمام تسجيل الدخول، يرجى إدخال هذا الكود.\n\n⚠️ الكود صالح لمدة 10 دقائق فقط.`;
        await wa.sendMessage([customer.phone], waMsg);
      } catch (waErr) {
        console.warn('[Customer Auth OTP] WhatsApp send failed:', waErr.message);
      }
    }

    // 3. Send via Gmail/HTML if email exists
    if (customer.email) {
      try {
        await emailService.sendCustomerAuthOtpEmail(customer.email, {
          code,
          username: customer.username,
          actionLabel: 'تأكيد تسجيل الدخول لحسابك'
        });
      } catch (emailErr) {
        console.error(`[Customer Auth OTP] Email send FAILED to ${customer.email}:`, emailErr.message);
      }
    }

    return res.status(200).json({
      requireOtp: true,
      otpKey,
      message: 'تم إرسال كود تحقق (OTP) إلى واتساب/جميل الخاص بك لتأكيد الدخول.',
      targetInfo: customer.phone ? `واتساب (${customer.phone}) / جميل (${customer.email})` : `الجميل (${customer.email})`
    });
  } catch (error) {
    console.error('Customer login error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تسجيل الدخول.' });
  }
});


// Verify Customer OTP (Register/Login Completion)
router.post('/verify-auth-otp', async (req, res) => {
  const { otpKey, code } = req.body;

  if (!otpKey || !code) {
    return res.status(400).json({ message: 'يرجى إدخال كود التحقق (OTP).' });
  }

  const item = await getCustomerOtp(otpKey);
  if (!item) {
    return res.status(400).json({ message: 'كود التحقق منتهي الصلاحية أو غير موجود. يرجى المحاولة مجدداً.' });
  }

  if (Date.now() > item.expiresAt) {
    await deleteCustomerOtp(otpKey);
    return res.status(400).json({ message: 'انتهت صلاحية كود التحقق.' });
  }

  if (item.code !== code.trim()) {
    return res.status(400).json({ message: 'كود التحقق غير صحيح، تأكد من الأرقام المدخلة.' });
  }

  try {
    if (item.type === 'register') {
      // Complete registration now
      const result = await runQuery(
        'INSERT INTO customers (username, email, password, phone) VALUES (?, ?, ?, ?)',
        [item.username, item.email, item.password, item.phone]
      );

      await deleteCustomerOtp(otpKey);

      const token = jwt.sign(
        { id: result.lastID, username: item.username },
        getJwtSecret(),
        { expiresIn: '30d' }
      );

      return res.status(201).json({
        message: 'تم التحقق وتفعيل الحساب بنجاح 🚀',
        token,
        customer: { id: result.lastID, username: item.username, email: item.email, phone: item.phone, balance: 0, balances: { "USD": 0, "USDT": 0 } }
      });
    } else if (item.type === 'login') {
      const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [item.customerId]);
      await deleteCustomerOtp(otpKey);

      if (!customer) {
        return res.status(404).json({ message: 'الحساب غير موجود.' });
      }

      const token = jwt.sign(
        { id: customer.id, username: customer.username },
        getJwtSecret(),
        { expiresIn: '30d' }
      );

      return res.json({
        message: 'تم التحقق وتسجيل الدخول بنجاح 🚀',
        token,
        customer: {
          id: customer.id,
          username: customer.username,
          email: customer.email || '',
          phone: customer.phone || '',
          balance: Number(customer.balance || 0),
          balances: customer.balances ? (typeof customer.balances === 'string' ? JSON.parse(customer.balances) : customer.balances) : {}
        }
      });
    }
  } catch (error) {
    console.error('Verify Auth OTP error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء التحقق وتفعيل الحساب.' });
  }
});

// Get Customer Orders
router.get('/orders', customerAuth, async (req, res) => {
  try {
    const orders = await allQuery('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC', [req.customer.id]);
    return res.json(orders);
  } catch (error) {
    console.error('Fetch customer orders error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب الطلبات.' });
  }
});

// Get current customer profile
router.get('/me', customerAuth, async (req, res) => {
  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
    if (!customer) {
      return res.status(404).json({ message: 'الحساب غير موجود.' });
    }

    // Fetch total orders count
    const orderCountRow = await getQuery('SELECT COUNT(*) as count FROM orders WHERE customer_id = ?', [req.customer.id]);
    const totalOrders = Number(orderCountRow ? orderCountRow.count : 0);

    const totalDeposited = Number(customer.total_deposited || 0);

    // Fetch all membership tiers
    const allTiers = (await allQuery('SELECT * FROM membership_tiers ORDER BY condition_value ASC')) || [];
    
    // Determine active tiers (auto-computed based on conditions)
    const autoTiers = allTiers.filter(tier => {
      if (tier.condition_type === 'total_orders') {
        return totalOrders >= Number(tier.condition_value);
      } else if (tier.condition_type === 'total_deposited') {
        return totalDeposited >= Number(tier.condition_value);
      }
      return false;
    });

    // Fetch manually assigned memberships
    let manualMemberships = [];
    try {
      manualMemberships = (await allQuery('SELECT * FROM user_memberships WHERE customer_id = ?', [req.customer.id])) || [];
    } catch (e) {
      console.warn('user_memberships table may not exist yet:', e.message);
    }

    // Merge: include both auto tiers and manually assigned tiers
    const manualTierIds = manualMemberships.map(m => Number(m.tier_id));
    const autoTierIds = autoTiers.map(t => Number(t.id));
    const allActiveTierIds = new Set([...autoTierIds, ...manualTierIds]);
    const activeTiers = allTiers.filter(t => allActiveTierIds.has(Number(t.id)));

    // Compute old tier/level just for fallback/backward compatibility if needed
    const computeLevel = (orderCount) => {
      if (orderCount >= 30) return 'diamond';
      if (orderCount >= 15) return 'gold';
      if (orderCount >= 5) return 'silver';
      return 'bronze';
    };
    const computedLevel = activeTiers.length > 0 ? activeTiers[activeTiers.length - 1].name : computeLevel(totalOrders);

    // Fetch active discounts
    const discounts = await allQuery('SELECT * FROM customer_discounts WHERE customer_id = ? AND is_active = true', [req.customer.id]);

    // Enrich manual memberships with tier info
    const manualMembershipsEnriched = manualMemberships.map(m => {
      const tier = allTiers.find(t => Number(t.id) === Number(m.tier_id));
      return {
        ...m,
        tier_name: tier ? tier.name : '',
        tier_icon: tier ? tier.icon : '⭐',
        tier_color: tier ? tier.color : '#fbbf24'
      };
    });

    return res.json({
      id: customer.id,
      username: customer.username,
      email: customer.email || '',
      phone: customer.phone || '',
      balance: Number(customer.balance || 0),
      balances: customer.balances ? (typeof customer.balances === 'string' ? JSON.parse(customer.balances) : customer.balances) : {},
      customer_level: computedLevel,
      is_vip: customer.is_vip === true || customer.is_vip === 'true' || customer.is_vip === 1,
      total_orders: totalOrders,
      total_deposited: totalDeposited,
      active_tiers: activeTiers,
      all_tiers: allTiers,
      manual_memberships: manualMembershipsEnriched,
      discounts: discounts || []
    });
  } catch (error) {
    console.error('Fetch customer profile error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب بيانات الحساب.' });
  }
});

// Customer wallet requests
router.get('/wallet-requests', customerAuth, async (req, res) => {
  try {
    const requests = await allQuery('SELECT * FROM wallet_requests WHERE customer_id = ? ORDER BY id DESC', [req.customer.id]);
    return res.json(requests);
  } catch (error) {
    console.error('Fetch customer wallet requests error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء جلب طلبات الشحن.' });
  }
});

router.post('/wallet-requests', customerAuth, async (req, res) => {
  const { amount, sender_phone, notes, currency, receipt_image } = req.body;
  const parsedAmount = Number(amount);
  const targetCurrency = currency || 'USD';

  if (!parsedAmount || parsedAmount <= 0) {
    return res.status(400).json({ message: 'يرجى إدخال مبلغ شحن صحيح.' });
  }

  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
    if (!customer) {
      return res.status(404).json({ message: 'الحساب غير موجود.' });
    }

    const result = await runQuery(
      'INSERT INTO wallet_requests (customer_id, customer_username, amount, currency, sender_phone, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [customer.id, customer.username, parsedAmount, targetCurrency, sender_phone || '', notes || '', 'pending']
    );

    const requestId = result.lastID;
    const created = await getQuery('SELECT * FROM wallet_requests WHERE id = ?', [requestId]);

    // ── Admin Notifications (Telegram + Gmail) ─────────────────────────
    let telegramSent = false;
    try {
      // 1. Telegram notification
      const adminChatIds = await telegram.getAdminChatIds();
      if (adminChatIds.length > 0) {
        const msgLines = [
          `💳 *طلب شحن رصيد جديد* #${requestId}`,
          `👤 العميل: *${customer.username}*`,
          `💰 المبلغ: *${parsedAmount} ${targetCurrency}*`,
          `📞 رقم التحويل: *${sender_phone || '-'}*`,
          notes ? `📝 ملاحظات: ${notes}` : null,
          `\nراجع الطلب في لوحة التحكم واعتمده أو ارفضه.`
        ].filter(Boolean).join('\n');

        for (const chatId of adminChatIds) {
          if (receipt_image) {
            await telegram.sendPhoto(String(chatId), receipt_image, msgLines).catch(() => {});
          } else {
            await telegram.sendMessage(String(chatId), msgLines).catch(() => {});
          }
        }
        console.log(`[Telegram Admin] Wallet request #${requestId} notification sent`);
        telegramSent = true;
      }

      // 2. Gmail / HTML notification to Admin
      const adminEmailRow = await getQuery("SELECT value FROM settings WHERE key = 'email_user'");
      const adminEmail = adminEmailRow ? adminEmailRow.value : '';
      await emailService.sendWalletRechargeAdminEmail(adminEmail, {
        requestId,
        customerUsername: customer.username,
        amount: parsedAmount,
        currency: targetCurrency,
        senderPhone: sender_phone,
        notes
      });
    } catch (notifyErr) {
      console.warn('[Wallet Notify] Failed to send admin notification:', notifyErr.message);
    }
    // ───────────────────────────────────────────────────

    return res.status(201).json({
      message: 'تم إرسال طلب شحن الرصيد بنجاح وهو بانتظار الموافقة.',
      id: requestId,
      request: created,
      telegram_sent: telegramSent
    });
  } catch (error) {
    console.error('Create wallet request error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إرسال طلب شحن الرصيد.' });
  }
});

// Admin: list all customers with safe fields only
router.get('/admin/customers', authMiddleware, async (req, res) => {
  try {
    const customers = (await allQuery('SELECT * FROM customers ORDER BY id DESC')) || [];
    // Get order counts per customer for level computation
    const orders = (await allQuery('SELECT customer_id, COUNT(*) as order_count, MAX(created_at) as last_order FROM orders WHERE customer_id IS NOT NULL GROUP BY customer_id')) || [];
    const orderMap = {};
    if (Array.isArray(orders)) {
      for (const o of orders) {
        orderMap[o.customer_id] = { count: Number(o.order_count || 0), last_order: o.last_order };
      }
    }

    const computeLevel = (orderCount) => {
      if (orderCount >= 30) return 'diamond';
      if (orderCount >= 15) return 'gold';
      if (orderCount >= 5) return 'silver';
      return 'bronze';
    };

    const safeCustomers = customers.map((customer) => {
      const orderInfo = orderMap[customer.id] || { count: 0, last_order: null };
      const computedLevel = computeLevel(orderInfo.count);
      return {
        id: customer.id,
        username: customer.username,
        email: customer.email || '',
        phone: customer.phone || '',
        balance: Number(customer.balance || 0),
        balances: customer.balances ? (typeof customer.balances === 'string' ? JSON.parse(customer.balances) : customer.balances) : {},
        has_password: Boolean(customer.password),
        password_masked: '********',
        customer_level: computedLevel,
        is_vip: customer.is_vip === true || customer.is_vip === 'true' || customer.is_vip === 1,
        total_orders: orderInfo.count,
        last_order_at: orderInfo.last_order || customer.last_order_at || null,
        api_key: customer.api_key || '',
        api_enabled: Boolean(customer.api_enabled),
        api_markup: Number(customer.api_markup || 0),
        api_blocked_services: customer.api_blocked_services ? JSON.parse(customer.api_blocked_services) : [],
        api_allowed_ips: customer.api_allowed_ips ? JSON.parse(customer.api_allowed_ips) : []
      };
    });

    res.json(safeCustomers);
  } catch (error) {
    console.error('Fetch customers admin error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب بيانات العملاء.' });
  }
});

// Admin: update customer profile and optionally reset password
router.put('/admin/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
    const { username, email, phone, balance, balances, new_password, api_enabled, api_markup, api_blocked_services, api_allowed_ips, regenerate_api_key } = req.body;

  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) {
      return res.status(404).json({ message: 'العميل غير موجود.' });
    }

    if (typeof new_password === 'string' && new_password.trim() && new_password.trim().length < 6) {
      return res.status(400).json({ message: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.' });
    }

    const nextUsername = typeof username === 'string' && username.trim() ? username.trim() : customer.username;
    const nextEmail = typeof email === 'string' ? email.trim().toLowerCase() : (customer.email || '');
    const nextPhone = typeof phone === 'string' ? phone.trim() : (customer.phone || '');
    const parsedBalance = balance === undefined || balance === null || balance === ''
      ? Number(customer.balance || 0)
      : Number(balance);

    if (Number.isNaN(parsedBalance) || parsedBalance < 0) {
      return res.status(400).json({ message: 'الرصيد غير صالح.' });
    }

    const duplicate = await getQuery('SELECT * FROM customers WHERE username = ?', [nextUsername]);
    if (duplicate && duplicate.id !== Number(id)) {
      return res.status(400).json({ message: 'اسم المستخدم مستخدم بالفعل.' });
    }

    if (nextEmail && nextEmail.trim() !== '') {
      const duplicateEmail = await getQuery('SELECT * FROM customers WHERE email = ?', [nextEmail]);
      if (duplicateEmail && duplicateEmail.id !== Number(id)) {
        return res.status(400).json({ message: 'البريد الإلكتروني مستخدم بالفعل.' });
      }
    }

    const nextBalances = typeof balances === 'object' ? JSON.stringify(balances) : (balances || '{}');

    const balanceDiff = parsedBalance > Number(customer.balance || 0) ? parsedBalance - Number(customer.balance || 0) : 0;
    const newTotalDeposited = Number(customer.total_deposited || 0) + balanceDiff;

    const nextApiEnabled = api_enabled !== undefined ? api_enabled : Boolean(customer.api_enabled);
    const nextApiMarkup = api_markup !== undefined ? Number(api_markup) : Number(customer.api_markup || 0);
    const nextApiBlocked = api_blocked_services ? JSON.stringify(api_blocked_services) : (customer.api_blocked_services || '[]');
    const nextApiIps = api_allowed_ips ? JSON.stringify(api_allowed_ips) : (customer.api_allowed_ips || '[]');

    await runQuery('UPDATE customers SET username = ?, email = ?, phone = ?, balance = ?, total_deposited = ?, balances = ?, api_enabled = ?, api_markup = ?, api_blocked_services = ?, api_allowed_ips = ? WHERE id = ?', [
      nextUsername,
      nextEmail,
      nextPhone,
      parsedBalance,
      newTotalDeposited,
      nextBalances,
      nextApiEnabled,
      nextApiMarkup,
      nextApiBlocked,
      nextApiIps,
      id
    ]);

    if (regenerate_api_key) {
      const crypto = require('crypto');
      const newApiKey = [1,2,3,4,5,6,7].map(() => crypto.randomBytes(3).toString('hex').toUpperCase()).join('-');
      await runQuery('UPDATE customers SET api_key = ? WHERE id = ?', [newApiKey, id]);
    }

    if (typeof new_password === 'string' && new_password.trim()) {
      const hashedNewPassword = await bcrypt.hash(new_password.trim(), 10);
      await runQuery('UPDATE customers SET password = ? WHERE id = ?', [hashedNewPassword, id]);
    }

    const updated = await getQuery('SELECT * FROM customers WHERE id = ?', [id]);
    res.json({
      message: 'تم تحديث بيانات العميل بنجاح.',
      customer: {
        id: updated.id,
        username: updated.username,
        email: updated.email || '',
        phone: updated.phone || '',
        balance: Number(updated.balance || 0),
        balances: updated.balances ? (typeof updated.balances === 'string' ? JSON.parse(updated.balances) : updated.balances) : {},
        has_password: Boolean(updated.password),
        password_masked: '********',
        api_key: updated.api_key || '',
        api_enabled: Boolean(updated.api_enabled),
        api_markup: Number(updated.api_markup || 0),
        api_blocked_services: updated.api_blocked_services ? JSON.parse(updated.api_blocked_services) : [],
        api_allowed_ips: updated.api_allowed_ips ? JSON.parse(updated.api_allowed_ips) : []
      }
    });
  } catch (error) {
    console.error('Update customer admin error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث بيانات العميل.' });
  }
});

// Admin: customer wallet transactions
router.get('/admin/:id/transactions', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) {
      return res.status(404).json({ message: 'العميل غير موجود.' });
    }

    const transactions = await allQuery('SELECT * FROM wallet_transactions WHERE customer_id = ? ORDER BY id DESC', [id]);
    res.json({
      customer: {
        id: customer.id,
        username: customer.username,
        phone: customer.phone || '',
        balance: Number(customer.balance || 0)
      },
      transactions
    });
  } catch (error) {
    console.error('Fetch customer transactions admin error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب سجل المعاملات.' });
  }
});

// Admin: delete customer account (Admin Protected)
router.delete('/admin/:id', authMiddleware, deleteOtpAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) {
      return res.status(404).json({ message: 'العميل غير موجود.' });
    }

    const { getDatabaseMode } = require('../db');
    if (getDatabaseMode().fallbackMode) {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '../database.json');
      if (fs.existsSync(dbPath)) {
        try {
          const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
          
          // Delete customer from customers array
          if (db.customers) {
            db.customers = db.customers.filter(c => Number(c.id) !== Number(id));
          }
          
          // Delete transactions associated with customer
          if (db.wallet_transactions) {
            db.wallet_transactions = db.wallet_transactions.filter(t => Number(t.customer_id) !== Number(id));
          }
          
          // Update orders associated with customer to customer_id = null
          if (db.orders) {
            db.orders = db.orders.map(o => {
              if (Number(o.customer_id) === Number(id)) {
                return { ...o, customer_id: null };
              }
              return o;
            });
          }
          
          // Delete wallet requests associated with customer
          if (db.wallet_requests) {
            db.wallet_requests = db.wallet_requests.filter(r => Number(r.customer_id) !== Number(id));
          }
          
          fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
        } catch (err) {
          console.error('JSON customer delete error:', err);
        }
      }
    } else {
      // PostgreSQL mode
      await runQuery('DELETE FROM customers WHERE id = ?', [id]);
      await runQuery('DELETE FROM wallet_transactions WHERE customer_id = ?', [id]);
      await runQuery('UPDATE orders SET customer_id = NULL WHERE customer_id = ?', [id]);
      await runQuery('DELETE FROM wallet_requests WHERE customer_id = ?', [id]);
    }

    res.json({ message: 'تم حذف العميل بنجاح وكل البيانات المرتبطة به.', id: Number(id) });
  } catch (error) {
    console.error('Delete customer admin error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف حساب العميل.' });
  }
});

// Admin: Toggle VIP status for a customer
router.put('/admin/:id/toggle-vip', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) {
      return res.status(404).json({ message: 'العميل غير موجود.' });
    }
    const currentVip = customer.is_vip === true || customer.is_vip === 'true' || customer.is_vip === 1;
    const newVip = !currentVip;
    await runQuery('UPDATE customers SET is_vip = ? WHERE id = ?', [newVip, id]);
    res.json({ message: newVip ? 'تم ترقية العميل إلى VIP بنجاح.' : 'تم إلغاء VIP للعميل.', is_vip: newVip });
  } catch (error) {
    console.error('Toggle VIP error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث حالة VIP.' });
  }
});

// Admin: Create a discount for a specific customer
router.post('/admin/:id/discount', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { discount_type, discount_value, description, service_id, category_id, expires_at } = req.body;

  if (!discount_value || Number(discount_value) <= 0) {
    return res.status(400).json({ message: 'يرجى إدخال قيمة خصم صحيحة.' });
  }

  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [id]);
    if (!customer) {
      return res.status(404).json({ message: 'العميل غير موجود.' });
    }

    const result = await runQuery(
      'INSERT INTO customer_discounts (customer_id, discount_type, discount_value, description, service_id, category_id, is_active, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        discount_type || 'percentage',
        Number(discount_value),
        description || '',
        service_id || null,
        category_id || null,
        true,
        expires_at || null
      ]
    );

    res.status(201).json({
      message: 'تم إنشاء عرض الخصم بنجاح.',
      discount: {
        id: result.lastID,
        customer_id: Number(id),
        discount_type: discount_type || 'percentage',
        discount_value: Number(discount_value),
        description: description || '',
        service_id: service_id || null,
        category_id: category_id || null,
        is_active: true,
        expires_at: expires_at || null
      }
    });
  } catch (error) {
    console.error('Create discount error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إنشاء عرض الخصم.' });
  }
});

// Admin: Get discounts for a specific customer
router.get('/admin/:id/discounts', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const discounts = await allQuery('SELECT * FROM customer_discounts WHERE customer_id = ? ORDER BY id DESC', [id]);
    res.json(discounts);
  } catch (error) {
    console.error('Fetch customer discounts error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب عروض الخصم.' });
  }
});

// Admin: Delete a discount
router.delete('/admin/discount/:discountId', authMiddleware, deleteOtpAuth, async (req, res) => {
  const { discountId } = req.params;
  try {
    await runQuery('DELETE FROM customer_discounts WHERE id = ?', [discountId]);
    res.json({ message: 'تم حذف عرض الخصم بنجاح.', id: Number(discountId) });
  } catch (error) {
    console.error('Delete discount error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف عرض الخصم.' });
  }
});

// Forgot Password Flow: 1. Send OTP
router.post('/forgot-password', turnstileMiddleware, async (req, res) => {
  const { identifier } = req.body; // email, username, or phone
  if (!identifier) return res.status(400).json({ message: 'يرجى إدخال البريد الإلكتروني، رقم الهاتف، أو اسم المستخدم.' });

  try {
    const identLower = identifier.trim().toLowerCase();
    const customer = await getQuery('SELECT * FROM customers WHERE username = ? OR email = ? OR phone = ?', [identLower, identLower, identifier.trim()]);
    if (!customer) {
      return res.status(404).json({ message: 'لم يتم العثور على حساب مرتبط بهذه البيانات.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await runQuery('UPDATE customers SET reset_otp = ?, reset_otp_expires = ? WHERE id = ?', [code, expiresAt, customer.id]);
    console.log(`[Forgot Password OTP] Code [${code}] saved for customer ${customer.username} (email: ${customer.email || 'N/A'}, phone: ${customer.phone || 'N/A'})`);

    // 1. Send via Telegram if customer has linked their Telegram account
    try {
      const telegramSent = await telegram.sendCustomerOtp(customer.id, code, customer.username, 'استعادة كلمة المرور');
      if (telegramSent) {
        console.log(`[Forgot Password OTP] Telegram sent to customer ${customer.username}`);
      } else {
        console.log(`[Forgot Password OTP] No Telegram chat_id for customer ${customer.username} — skipping Telegram`);
      }
    } catch (e) {
      console.warn('[Forgot Password OTP] Telegram send failed:', e.message);
    }

    // 2. Send via WhatsApp
    if (customer.phone) {
      try {
        const waMsg = `مرحباً بك في عرب تك سيرفر 🚀\n\nكود استعادة كلمة المرور الخاص بك هو: *${code}*\nلإعادة تعيين كلمة المرور، يرجى إدخال هذا الكود.\n\n⚠️ الكود صالح لمدة 15 دقيقة فقط.`;
        await wa.sendMessage([customer.phone], waMsg);
      } catch (waErr) {
        console.warn('[Forgot Password OTP] WhatsApp send failed:', waErr.message);
      }
    }

    // 3. Send via Email (independent try/catch — never blocks the response)
    if (customer.email) {
      try {
        await emailService.sendCustomerAuthOtpEmail(customer.email, {
          code,
          username: customer.username,
          actionLabel: 'استعادة كلمة المرور الخاصة بحسابك'
        });
      } catch (emailErr) {
        console.error(`[Forgot Password OTP] Email send FAILED to ${customer.email}:`, emailErr.message);
      }
    } else {
      console.warn(`[Forgot Password OTP] No email found for customer ${customer.username} — skipping email.`);
    }

    return res.json({ message: 'تم إرسال كود الاستعادة إلى واتساب والبريد الإلكتروني الخاص بك.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء طلب استعادة كلمة المرور.' });
  }
});

// Forgot Password Flow: 2. Verify OTP
router.post('/verify-forgot-otp', async (req, res) => {
  const { identifier, code } = req.body;
  if (!identifier || !code) return res.status(400).json({ message: 'يرجى إدخال البيانات والكود.' });

  try {
    const identLower = identifier.trim().toLowerCase();
    const customer = await getQuery('SELECT * FROM customers WHERE username = ? OR email = ? OR phone = ?', [identLower, identLower, identifier.trim()]);
    if (!customer) return res.status(404).json({ message: 'لم يتم العثور على حساب مرتبط بهذه البيانات.' });

    if (!customer.reset_otp || customer.reset_otp !== code.trim()) {
      return res.status(400).json({ message: 'الكود غير صحيح.' });
    }

    const expiresAt = new Date(customer.reset_otp_expires).getTime();
    if (Date.now() > expiresAt) {
      return res.status(400).json({ message: 'عذراً، انتهت صلاحية الكود. يرجى طلب كود جديد.' });
    }

    const tempToken = jwt.sign({ id: customer.id, action: 'reset-password' }, getJwtSecret(), { expiresIn: '15m' });

    return res.json({ message: 'تم التحقق من الكود بنجاح.', token: tempToken });
  } catch (error) {
    console.error('Verify forgot OTP error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء التحقق من الكود.' });
  }
});

// Forgot Password Flow: 3. Reset Password
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ message: 'يرجى إرسال التوكن وكلمة المرور الجديدة.' });
  if (newPassword.length < 6) return res.status(400).json({ message: 'يجب أن تكون كلمة المرور 6 أحرف على الأقل.' });

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.action !== 'reset-password') return res.status(400).json({ message: 'توكن غير صالح.' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await runQuery('UPDATE customers SET password = ?, reset_otp = NULL, reset_otp_expires = NULL WHERE id = ?', [hashedPassword, decoded.id]);

    return res.json({ message: 'تم تغيير كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول.' });
  } catch (error) {
    console.error('Reset password error:', error);
    if (error.name === 'TokenExpiredError') return res.status(400).json({ message: 'انتهت صلاحية الجلسة، يرجى المحاولة مرة أخرى.' });
    return res.status(500).json({ message: 'حدث خطأ أثناء تغيير كلمة المرور.' });
  }
});

// --- Password Change Flow (Logged-in User) ---
router.post('/request-otp', customerAuth, async (req, res) => {
  const { method } = req.body; // 'email' or 'telegram'
  try {
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
    if (!customer) return res.status(404).json({ message: 'الحساب غير موجود.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const otpKey = `change_${customer.id}`;

    await setCustomerOtp(otpKey, {
      code,
      type: 'change-password',
      customerId: customer.id,
      expiresAt
    });

    if (method === 'telegram') {
      try {
        await telegram.sendCustomerOtp(customer.id, code, customer.username, 'تغيير كلمة المرور');
      } catch (err) {
        console.warn('Telegram send failed:', err.message);
        return res.status(500).json({ message: 'فشل إرسال الكود عبر تليجرام. تأكد من ربط حسابك.' });
      }
    } else {
      if (!customer.email) return res.status(400).json({ message: 'لا يوجد بريد إلكتروني مرتبط بحسابك.' });
      try {
        await emailService.sendCustomerAuthOtpEmail(customer.email, {
          code,
          username: customer.username,
          actionLabel: 'تغيير كلمة المرور الخاصة بك'
        });
      } catch (emailErr) {
        console.error(`[Change Password OTP] Email send FAILED to ${customer.email}:`, emailErr.message);
        return res.status(500).json({ message: 'فشل إرسال الكود إلى بريدك الإلكتروني. تأكد من إعدادات البريد أو اتصل بالإدارة.' });
      }
    }

    return res.json({ message: 'تم الإرسال بنجاح' });
  } catch (error) {
    console.error('Request OTP error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء إرسال الكود.' });
  }
});

router.post('/change-password', customerAuth, async (req, res) => {
  const { otp, newPassword } = req.body;
  if (!otp || !newPassword) return res.status(400).json({ message: 'يرجى إرسال الكود وكلمة المرور الجديدة.' });
  if (newPassword.length < 6) return res.status(400).json({ message: 'يجب أن تكون كلمة المرور 6 أحرف على الأقل.' });

  try {
    const otpKey = `change_${req.customer.id}`;
    const item = await getCustomerOtp(otpKey);

    if (!item) return res.status(400).json({ message: 'كود التحقق منتهي الصلاحية أو غير موجود.' });
    if (Date.now() > item.expiresAt) {
      await deleteCustomerOtp(otpKey);
      return res.status(400).json({ message: 'انتهت صلاحية كود التحقق.' });
    }
    if (item.code !== otp.trim()) return res.status(400).json({ message: 'كود التحقق غير صحيح.' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await runQuery('UPDATE customers SET password = ? WHERE id = ?', [hashedPassword, req.customer.id]);
    
    await deleteCustomerOtp(otpKey);
    return res.json({ message: 'تم تغيير كلمة المرور بنجاح.' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء تغيير كلمة المرور.' });
  }
});

// ==============================
// API Key Management Routes
// ==============================

const crypto = require('crypto');

// Generate a random 32-character hex API key
function generateApiKey() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// Get Customer's API Key and settings
router.get('/dev-settings', customerAuth, async (req, res) => {
  try {
    const customer = await getQuery('SELECT api_key, api_enabled, api_allowed_ips, api_markup, api_requested FROM customers WHERE id = ?', [req.customer.id]);
    if (!customer) {
      return res.status(404).json({ message: 'العميل غير موجود' });
    }
    res.json({
      success: true,
      api_key: customer.api_key || '',
      api_enabled: Boolean(customer.api_enabled),
      api_requested: Boolean(customer.api_requested),
      api_allowed_ips: customer.api_allowed_ips || '[]',
      api_markup: customer.api_markup || 0
    });
  } catch (error) {
    console.error('Fetch API key error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب بيانات الـ API.' });
  }
});

// Request API Access
router.post('/request-api', customerAuth, async (req, res) => {
  try {
    const customer = await getQuery('SELECT api_key FROM customers WHERE id = ?', [req.customer.id]);
    
    let newApiKey = customer.api_key;
    if (!newApiKey) {
        newApiKey = generateApiKey();
    }

    await runQuery('UPDATE customers SET api_enabled = true, api_requested = false, api_key = ? WHERE id = ?', [newApiKey, req.customer.id]);
    res.json({ success: true, message: 'تم تفعيل الـ API وإنشاء المفتاح بنجاح.' });
  } catch (error) {
    console.error('Request API error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إرسال الطلب.' });
  }
});

// Regenerate API Key
router.post('/dev-settings/regenerate', customerAuth, async (req, res) => {
  try {
    const newApiKey = generateApiKey();
    await runQuery('UPDATE customers SET api_key = ? WHERE id = ?', [newApiKey, req.customer.id]);
    res.json({
      success: true,
      api_key: newApiKey,
      message: 'تم توليد مفتاح API جديد بنجاح.'
    });
  } catch (error) {
    console.error('Regenerate API key error:', error);
    if (error.message && error.message.includes('UNIQUE')) {
       // Highly unlikely, but just in case
       return res.status(500).json({ message: 'حدث تضارب في المفتاح، يرجى المحاولة مرة أخرى.' });
    }
    res.status(500).json({ message: 'حدث خطأ أثناء توليد المفتاح الجديد.' });
  }
});

// Update Allowed IPs
router.put('/dev-settings/allowed-ips', customerAuth, async (req, res) => {
  const { ips } = req.body;
  if (!Array.isArray(ips)) {
    return res.status(400).json({ message: 'يجب أن يكون الحقل ips مصفوفة من العناوين.' });
  }

  try {
    await runQuery('UPDATE customers SET api_allowed_ips = ? WHERE id = ?', [JSON.stringify(ips), req.customer.id]);
    res.json({
      success: true,
      message: 'تم تحديث قائمة الـ IPs المسموحة بنجاح.'
    });
  } catch (error) {
    console.error('Update allowed IPs error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث قائمة الـ IPs.' });
  }
});

// Admin: Get API Logs for a specific customer
router.get('/admin/:id/api-logs', authMiddleware, async (req, res) => {
  try {
    const customerId = req.params.id;
    const logs = await allQuery('SELECT * FROM api_logs WHERE customer_id = ? ORDER BY id DESC LIMIT 100', [customerId]);
    res.json(logs || []);
  } catch (error) {
    console.error('Fetch API logs error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب سجلات الـ API.' });
  }
});

module.exports = router;
