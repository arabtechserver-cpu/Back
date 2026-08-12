const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { runQuery, allQuery, getQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const deleteOtpAuth = require('../middleware/deleteOtpAuth');
const telegram = require('../utils/telegramService');
const { getJwtSecret } = require('../utils/security');
const unlockerRoutes = require('./unlockerRoutes');
const emailService = require('../utils/emailService');
const notificationHelper = require('../utils/notificationHelper');

// Helper to check folder size recursively
function getDirSize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  const files = fs.readdirSync(dirPath);
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(dirPath, files[i]);
    try {
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        size += stats.size;
      } else if (stats.isDirectory()) {
        size += getDirSize(filePath);
      }
    } catch (e) {
      // Ignore files that are deleted mid-process
    }
  }
  return size;
}

const receiptsDir = path.join(__dirname, '../uploads/receipts');
if (!fs.existsSync(receiptsDir)) {
  fs.mkdirSync(receiptsDir, { recursive: true });
}

// Get most popular services (Public - for homepage)
router.get('/popular-services', async (req, res) => {
  try {
    let popular = await allQuery(`
      SELECT 
        s.id, s.name, s.image, s.packages,
        c.name as category_name, c.id as category_id, c.color as category_color,
        (SELECT COUNT(o.id) FROM orders o WHERE o.service_id = s.id AND o.status IN ('completed', 'pending', 'processing')) as order_count
      FROM services s
      JOIN categories c ON s.category_id = c.id
      WHERE s.is_popular = true
      ORDER BY order_count DESC
      LIMIT 8
    `);

    // Fallback: If no popular services found (e.g., brand new store with no orders, and no manual ones)
    if (!popular || popular.length === 0) {
      popular = await allQuery(`
        SELECT 
          s.id, s.name, s.image, s.packages,
          c.name as category_name, c.id as category_id, c.color as category_color,
          COUNT(o.id) as order_count
        FROM orders o
        JOIN services s ON o.service_id = s.id
        JOIN categories c ON s.category_id = c.id
        WHERE o.status IN ('completed', 'pending', 'processing')
        GROUP BY o.service_id, s.id, s.name, s.image, s.packages, c.name, c.id, c.color
        ORDER BY order_count DESC
        LIMIT 8
      `);
    }

    if (!popular || popular.length === 0) {
      popular = await allQuery(`
        SELECT 
          s.id, s.name, s.image, s.packages,
          c.name as category_name, c.id as category_id, c.color as category_color,
          0 as order_count
        FROM services s
        JOIN categories c ON s.category_id = c.id
        ORDER BY RANDOM()
        LIMIT 8
      `);
    }

    res.json(popular || []);
  } catch (error) {
    console.error('Popular services error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الخدمات.' });
  }
});

// Get recent orders (Public - for social proof)
router.get('/recent', async (req, res) => {
  try {
    const recent = await allQuery(`
      SELECT 
        o.service_name, 
        c.username as customer_name,
        o.created_at
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE o.status != 'cancelled'
      ORDER BY o.id DESC
      LIMIT 3
    `);
    res.json(recent || []);
  } catch (error) {
    console.error('Recent orders error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الطلبات الأخيرة.' });
  }
});

// Submit new order (Public)
router.post('/', async (req, res) => {
  const { service_id, player_id, phone, package_name, package_price, payment_method, sender_phone, transfer_to, quantity, receipt_image, transfer_amount, custom_fields } = req.body;
  const orderPrice = Number(package_price);
  const normalizedPaymentMethod = payment_method === 'transfer' ? 'transfer' : 'wallet';
  const normalizedSenderPhone = typeof sender_phone === 'string' ? sender_phone.trim() : '';
  const normalizedTransferTo = typeof transfer_to === 'string' ? transfer_to.trim() : '01026785879';

  if (!service_id || player_id === undefined || !package_name || package_price === undefined) {
    return res.status(400).json({ message: 'جميع الحقول مطلوبة لإكمال إرسال الطلب.' });
  }

  const finalPhone = typeof phone === 'string' ? phone.trim() : '';

  if (Number.isNaN(orderPrice) || orderPrice < 0) {
    return res.status(400).json({ message: 'سعر الباقة غير صالح.' });
  }

  if (normalizedPaymentMethod === 'transfer' && (!normalizedSenderPhone || !receipt_image || !transfer_amount)) {
    return res.status(400).json({ message: 'يرجى إدخال الرقم المحول منه، تحديد قيمة التحويل، ورفع صورة إيصال التحويل.' });
  }

  try {
    // Verify service and get parent category name and download link
    const serviceInfo = await getQuery(`
      SELECT s.name as service_name, s.download_link, s.download_link_title, s.api_source, c.name as category_name 
      FROM services s 
      JOIN categories c ON s.category_id = c.id 
      WHERE s.id = ?
    `, [service_id]);

    if (!serviceInfo) {
      return res.status(404).json({ message: 'الخدمة المطلوبة غير متوفرة.' });
    }

    // Check if user is logged in as a customer
    let customerId = null;
    let customer = null;
    let balanceBefore = null;
    let balanceAfter = null;
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, getJwtSecret());
        customerId = decoded.id;

        customer = await getQuery('SELECT * FROM customers WHERE id = ?', [customerId]);
        if (!customer) {
          return res.status(404).json({ message: 'الحساب غير موجود.' });
        }

        if (normalizedPaymentMethod === 'wallet') {
          balanceBefore = Number(customer.balance || 0);
          if (balanceBefore < orderPrice) {
            return res.status(400).json({ message: 'رصيد المحفظة غير كافٍ لإتمام هذه العملية.' });
          }
          balanceAfter = balanceBefore - orderPrice;
        }
      } catch (err) {
        // Continue as guest if token is invalid
      }
    }

    if (normalizedPaymentMethod === 'wallet' && !customerId) {
      return res.status(401).json({ message: 'يجب تسجيل الدخول لاستخدام المحفظة في الدفع.' });
    }

    // Handle receipt image saving if provided
    let savedReceiptPath = '';
    if (normalizedPaymentMethod === 'transfer' && receipt_image && typeof receipt_image === 'string' && receipt_image.startsWith('data:image')) {
      // Check folder size limit (1 GB in bytes)
      const currentSize = getDirSize(receiptsDir);
      const limitBytes = 1 * 1024 * 1024 * 1024; // 1 GB
      if (currentSize >= limitBytes) {
        return res.status(400).json({ message: 'سعة تخزين السيرفر ممتلئة بالصور (1 جيجابايت). يرجى الاتصال بالإدارة لتفريغ المساحة.' });
      }

      // Decode and save the Base64 image
      const matches = receipt_image.match(/^data:image\/([A-Za-z+]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const imageType = matches[1];
        const dataBuffer = Buffer.from(matches[2], 'base64');
        const filename = `receipt_${Date.now()}_${Math.floor(Math.random() * 10000)}.webp`;
        const fullPath = path.join(receiptsDir, filename);

        try {
          const sharp = require('sharp');
          await sharp(dataBuffer).webp({ quality: 80 }).toFile(fullPath);
          savedReceiptPath = `/uploads/receipts/${filename}`;
        } catch (err) {
          console.error('Failed to convert receipt to WebP:', err);
          const ext = imageType === 'jpeg' ? 'jpg' : imageType;
          const fallbackFilename = `receipt_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
          const fallbackPath = path.join(receiptsDir, fallbackFilename);
          const fs = require('fs');
          fs.writeFileSync(fallbackPath, dataBuffer);
          savedReceiptPath = `/uploads/receipts/${fallbackFilename}`;
        }
      }
    }

    const result = await runQuery(`
      INSERT INTO orders (service_id, service_name, category_name, player_id, phone, package_name, package_price, customer_id, payment_method, sender_phone, transfer_to, quantity, receipt_image, transfer_amount, download_link, download_link_title, api_source, custom_fields)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      service_id, 
      serviceInfo.service_name, 
      serviceInfo.category_name, 
      player_id, 
      finalPhone, 
      package_name, 
      package_price,
      customerId,
      normalizedPaymentMethod,
      normalizedSenderPhone,
      normalizedTransferTo,
      quantity ? parseInt(quantity) : 1,
      savedReceiptPath,
      transfer_amount ? Number(transfer_amount) : 0,
      serviceInfo.download_link || '',
      serviceInfo.download_link_title || '',
      serviceInfo.api_source || '',
      JSON.stringify(custom_fields || {})
    ]);

    if (customerId && customer && normalizedPaymentMethod === 'wallet') {
      const updRes = await runQuery('UPDATE customers SET balance = balance - ? WHERE id = ? AND balance >= ?', [orderPrice, customerId, orderPrice]);
      if (updRes && updRes.changes === 0 && updRes.rowCount === 0) {
         await runQuery('DELETE FROM orders WHERE id = ?', [result.lastID]);
         return res.status(400).json({ message: 'رصيد المحفظة غير كافٍ لإتمام هذه العملية (حدث تضارب).' });
      }
      await runQuery(
        'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          customerId,
          customer.username,
          'debit',
          orderPrice,
          balanceBefore,
          balanceAfter,
          'order',
          result.lastID,
          `شراء خدمة ${serviceInfo.service_name} - ${package_name}`
        ]
      );
    }
    
    // Auto-submit API orders paid with wallet balance in BACKGROUND (fire-and-forget)
    // This prevents timeout-caused duplicate submissions from the frontend
    let autoSubmitted = false;
    if (normalizedPaymentMethod === 'wallet' && serviceInfo.api_source === 'amrr-unlocker') {
      const autoSubmitSetting = await getQuery("SELECT value FROM settings WHERE key = 'api_auto_submit'");
      const isAutoSubmitEnabled = autoSubmitSetting ? autoSubmitSetting.value === 'true' : false; // Disabled by default per user request
      if (isAutoSubmitEnabled) {
        autoSubmitted = true;
        const orderId = result.lastID;
        ;(async () => {
          try {
            console.log(`[Auto Submit] Placing API order for order #${orderId} in background...`);
            await unlockerRoutes.autoSubmitUnlockerOrder(orderId);
          } catch (e) {
            console.error(`[Auto Submit Error] Failed to place order #${orderId}:`, e.message);
          }
        })();
      }
    }

    // ── Telegram + Gmail: Admin notification for new order ──────────────
    ;(async () => {
      try {
        const orderId = result.lastID;
        const payLabel = normalizedPaymentMethod === 'wallet' ? '💳 محفظة' : '💸 تحويل';

        // 1. Telegram admin notification
        const adminChatIds = await telegram.getAdminChatIds();
        if (adminChatIds.length > 0) {
          const tgMsg = [
            `🛒 *طلب شحن جديد #${orderId}*`,
            `🎮 الخدمة: *${serviceInfo.service_name}*`,
            `📦 الباقة: *${package_name}* — *${package_price}*`,
            `🆔 رقم اللاعب: \`${player_id}\``,
            `📞 رقم الهاتف: \`${phone || '-'}\``,
            customer ? `👤 العميل: *${customer.username}*` : `👤 *زائر (بدون حساب)*`,
            `💳 طريقة الدفع: ${payLabel}`,
            autoSubmitted ? `⚡ *تفعيل تلقائي قيد المعالجة (API)*` : null,
            normalizedPaymentMethod === 'transfer' && normalizedSenderPhone ? `📤 محوّل من: \`${normalizedSenderPhone}\`` : null,
            `\n🔗 راجع الطلب في لوحة التحكم`
          ].filter(Boolean).join('\n');
          for (const chatId of adminChatIds) {
            if (savedReceiptPath) {
              const fullImagePath = path.join(__dirname, '..', savedReceiptPath);
              await telegram.sendPhoto(String(chatId), fullImagePath, tgMsg).catch(() => {});
            } else {
              await telegram.sendMessage(String(chatId), tgMsg).catch(() => {});
            }
          }
          console.log(`[Telegram Admin] Order #${orderId} notification sent to ${adminChatIds.length} admin(s)`);
        }

        // 2. Gmail admin notification
        const adminEmailRow = await getQuery("SELECT value FROM settings WHERE key = 'email_user'");
        const adminEmail = adminEmailRow ? adminEmailRow.value : '';
        if (adminEmail) {
          const emailService = require('../utils/emailService');
          await emailService.sendWalletRechargeAdminEmail(adminEmail, {
            requestId: orderId,
            customerUsername: customer ? customer.username : 'زائر',
            amount: package_price,
            currency: 'USD',
            senderPhone: normalizedSenderPhone || '',
            notes: `خدمة: ${serviceInfo.service_name} — باقة: ${package_name}`
          }).catch(() => {});
        }
      } catch (notifyErr) {
        console.warn('[Admin Notify] Failed to send admin notification:', notifyErr.message);
      }
    })();
    // ── Telegram + Gmail: Customer notification for new order ─────────────
    ;(async () => {
      try {
        const orderId = result.lastID;
        // Telegram — only if customer has linked account
        if (customerId && customer && customer.telegram_chat_id) {
          const tgMsg = [
            `📦 *تم استلام طلبك بنجاح!*`,
            ``,
            `▫️ رقم الطلب: *#${orderId}*`,
            `▫️ الخدمة: *${serviceInfo.service_name}*`,
            `▫️ الباقة: *${package_name}*`,
            `▫️ الحالة: ⏳ قيد المراجعة والتنفيذ`,
            ``,
            `سوف تصلك رسالة أخرى فور إتمام تنفيذه من الإدارة.\nشكراً لثقتك بنا! 🚀 — عرب تك سيرفر`
          ].join('\n');
          await telegram.sendMessage(customer.telegram_chat_id, tgMsg);
          console.log(`[Telegram Customer] Order #${orderId} submitted notification sent ✓`);
        }

        // Gmail
        const targetEmail = (typeof req.body.email === 'string' && req.body.email.trim()) ? req.body.email.trim() : (customer ? customer.email : '');
        if (targetEmail) {
          const emailService = require('../utils/emailService');
          await emailService.sendOrderSubmittedEmail(targetEmail, {
            orderId,
            serviceName: serviceInfo.service_name,
            packageName: package_name,
            price: package_price,
            playerId: player_id
          }).catch(e => console.warn('[Gmail Customer] sendOrderSubmittedEmail failed:', e.message));
        }
      } catch (custErr) {
        console.warn('[Customer Notify Error] Failed to send submitted notifications:', custErr.message);
      }
    })();
    // ─────────────────────────────────────────────────────────────────────

    res.status(201).json({
      message: autoSubmitted ? 'تم إرسال الطلب وتفعيله تلقائياً وجاري معالجته.' : 'تم إرسال الطلب بنجاح وهو قيد المراجعة الآن.',
      id: result.lastID,
      service_name: serviceInfo.service_name,
      category_name: serviceInfo.category_name,
      player_id,
      phone,
      package_name,
      package_price,
      payment_method: normalizedPaymentMethod,
      sender_phone: normalizedSenderPhone,
      transfer_to: normalizedTransferTo,
      status: autoSubmitted ? 'processing' : 'pending',
      quantity: quantity ? parseInt(quantity) : 1,
      receipt_image: savedReceiptPath,
      transfer_amount: transfer_amount ? Number(transfer_amount) : 0,
      customer_balance: customerId && customer ? balanceAfter : undefined,
      download_link: serviceInfo.download_link || '',
      download_link_title: serviceInfo.download_link_title || ''
    });
  } catch (error) {
    console.error('Submit order error:', error);
    res.status(500).json({ message: error.message && (error.message.includes('رصيد') || error.message.includes('طلب') || error.message.includes('خدمة')) ? error.message : 'حدث خطأ أثناء إرسال الطلب.' });
  }
});

// Track single order (Public - requires ID and Phone)
router.get('/track', async (req, res) => {
  const { id, phone } = req.query;
  
  if (!id || !phone) {
    return res.status(400).json({ message: 'يرجى إدخال رقم الطلب ورقم الهاتف للتتبع.' });
  }

  try {
    const order = await getQuery('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order || order.phone.trim() !== phone.trim()) {
      return res.status(404).json({ message: 'تعذر العثور على الطلب، يرجى التأكد من البيانات المدخلة.' });
    }

    res.json({
      id: order.id,
      service_name: order.service_name,
      category_name: order.category_name,
      package_name: order.package_name,
      package_price: order.package_price,
      player_id: order.player_id,
      status: order.status,
      created_at: order.created_at,
      receipt_image: order.receipt_image,
      transfer_amount: order.transfer_amount,
      code: order.code || '',
      download_link: order.download_link || '',
      download_link_title: order.download_link_title || ''
    });
  } catch (error) {
    console.error('Track order error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تتبع الطلب.' });
  }
});

// Get all orders (Admin Protected)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const orders = (await allQuery(`
      SELECT
        o.id, o.service_id, o.service_name, o.category_name, o.player_id, o.phone,
        o.package_name, o.package_price, o.customer_id, o.payment_method, o.sender_phone,
        o.transfer_to, o.quantity, o.receipt_image, o.transfer_amount, o.download_link,
        o.download_link_title, o.status, o.code, o.created_at, NULL AS processed_at,
        o.api_source, o.api_order_id, o.api_status, o.custom_fields,
        o.is_api_order, o.api_reseller_id, s.api_provider_id
      FROM orders o
      LEFT JOIN services s ON o.service_id = s.id
      ORDER BY o.id DESC
      LIMIT ?
    `, [limit])) || [];
    const customers = (await allQuery('SELECT id, username FROM customers')) || [];
    const customersMap = {};
    if (Array.isArray(customers)) {
      customers.forEach(c => {
        if (c && c.id !== undefined) customersMap[c.id] = c.username || 'عميل';
      });
    }

    const ordersList = Array.isArray(orders) ? orders : [];
    const ordersWithUsername = ordersList.map(order => ({
      ...order,
      customer_username: order && order.customer_id ? (customersMap[order.customer_id] || 'حساب محذوف') : 'زائر (بدون حساب)'
    }));

    res.json(ordersWithUsername);
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الطلبات.' });
  }
});

// Update order status and code (Admin Protected)
router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status, code, download_link, download_link_title } = req.body; // pending, completed, cancelled

  if (status && !['pending', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ message: 'حالة الطلب غير صالحة.' });
  }

  try {
    const order = await getQuery('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) {
      return res.status(404).json({ message: 'الطلب غير موجود.' });
    }

    const nextStatus = status || order.status;
    const nextCode = code !== undefined ? code : (order.code || '');
    const nextDownloadLink = download_link !== undefined ? download_link : (order.download_link || '');
    const nextDownloadLinkTitle = download_link_title !== undefined ? download_link_title : (order.download_link_title || '');

    // Refund wallet if status changes to cancelled and wasn't already cancelled
    if (nextStatus === 'cancelled' && order.status !== 'cancelled' && order.payment_method === 'wallet' && order.customer_id) {
      const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [order.customer_id]);
      if (customer) {
        const refundAmount = Number(order.package_price || 0);
        const balanceBefore = Number(customer.balance || 0);
        const balanceAfter = balanceBefore + refundAmount;

        await runQuery('UPDATE customers SET balance = balance + ? WHERE id = ?', [refundAmount, order.customer_id]);
        await runQuery(
          'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            customer.id,
            customer.username,
            'credit',
            refundAmount,
            balanceBefore,
            balanceAfter,
            'order_refund',
            order.id,
            `استرداد قيمة إلغاء طلب شحن #${order.id}`
          ]
        );
      }
    } else if (order.status === 'cancelled' && nextStatus !== 'cancelled' && order.payment_method === 'wallet' && order.customer_id) {
      const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [order.customer_id]);
      if (customer) {
        const deductionAmount = Number(order.package_price || 0);
        const balanceBefore = Number(customer.balance || 0);
        if (balanceBefore < deductionAmount) {
          return res.status(400).json({ message: `لا يمكن إعادة تفعيل الطلب لأن رصيد العميل الحالي (${balanceBefore}) غير كافٍ لخصم ثمن الباقة (${deductionAmount}).` });
        }
        const balanceAfter = balanceBefore - deductionAmount;

        const updRes = await runQuery('UPDATE customers SET balance = balance - ? WHERE id = ? AND balance >= ?', [deductionAmount, order.customer_id, deductionAmount]);
        if (updRes && updRes.changes === 0 && updRes.rowCount === 0) {
           return res.status(400).json({ message: 'رصيد المحفظة غير كافٍ لإعادة تفعيل الطلب.' });
        }
        await runQuery(
          'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            customer.id,
            customer.username,
            'debit',
            deductionAmount,
            balanceBefore,
            balanceAfter,
            'order',
            order.id,
            `إعادة تفعيل طلب شحن #${order.id} من الإلغاء`
          ]
        );
      }
    }

    await runQuery('UPDATE orders SET status = ?, code = ?, download_link = ?, download_link_title = ? WHERE id = ?', [nextStatus, nextCode, nextDownloadLink, nextDownloadLinkTitle, id]);

    // Send WhatsApp + Gmail notification to customer if status/code changes
    if ((order.phone || order.customer_id) && (nextStatus !== order.status || nextCode !== (order.code || '') || nextDownloadLink !== (order.download_link || ''))) {
      ;(async () => {
        try {
          await notificationHelper.notifyCustomerOfOrderUpdate(id, nextStatus, nextCode, nextDownloadLink, nextDownloadLinkTitle);
        } catch (err) {
          console.warn('[Customer Notify Error] Failed to notify customer about order update:', err.message);
        }
      })();
    }

    res.json({ message: 'تم تحديث الطلب بنجاح.', id, status: nextStatus, code: nextCode, download_link: nextDownloadLink, download_link_title: nextDownloadLinkTitle });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث الطلب.' });
  }
});

// Clear all receipt images (Admin Protected)
router.delete('/receipts/clear', authMiddleware, deleteOtpAuth, async (req, res) => {
  try {
    if (fs.existsSync(receiptsDir)) {
      const files = fs.readdirSync(receiptsDir);
      for (let i = 0; i < files.length; i++) {
        const filePath = path.join(receiptsDir, files[i]);
        fs.unlinkSync(filePath);
      }
    }
    res.json({ message: 'تم إفراغ كافة صور إيصالات التحويل من السيرفر بنجاح.' });
  } catch (error) {
    console.error('Clear receipts error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إفراغ الصور من السيرفر.' });
  }
});

// Delete order (Admin Protected)
router.delete('/:id', authMiddleware, deleteOtpAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const order = await getQuery('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) {
      return res.status(404).json({ message: 'الطلب غير موجود.' });
    }

    // Try to delete physical receipt image file if it exists
    if (order.receipt_image && order.receipt_image.startsWith('/uploads/receipts/')) {
      try {
        const filePath = path.join(__dirname, '..', order.receipt_image);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error('Failed to delete physical file for order:', order.id, err.message);
      }
    }

    const refundableStatuses = ['pending', 'processing'];
    if (order.payment_method === 'wallet' && order.customer_id && refundableStatuses.includes(order.status)) {
      const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [order.customer_id]);
      if (customer) {
        const refundAmount = Number(order.package_price || 0);
        const balanceBefore = Number(customer.balance || 0);
        const balanceAfter = balanceBefore + refundAmount;

        await runQuery('UPDATE customers SET balance = balance + ? WHERE id = ?', [refundAmount, order.customer_id]);
        await runQuery(
          'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            customer.id,
            customer.username,
            'credit',
            refundAmount,
            balanceBefore,
            balanceAfter,
            'order_refund',
            order.id,
            `استرداد قيمة الطلب المحذوف #${order.id}`
          ]
        );
      }
    }

    await runQuery('DELETE FROM orders WHERE id = ?', [id]);
    res.json({ message: 'تم حذف الطلب بنجاح.', id: Number(id) });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف الطلب.' });
  }
});

// Admin: Manually refund order to customer's wallet (Admin Protected)
router.post('/:id/refund', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const order = await getQuery('SELECT * FROM orders WHERE id = ?', [id]);
    if (!order) {
      return res.status(404).json({ message: 'الطلب غير موجود.' });
    }

    if (order.payment_method !== 'wallet') {
      return res.status(400).json({ message: 'هذا الطلب لم يتم دفعه من خلال المحفظة، ولا يمكن استرداد قيمته للمحفظة.' });
    }

    if (!order.customer_id) {
      return res.status(400).json({ message: 'الطلب غير مرتبط بحساب عميل مسجل.' });
    }

    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [order.customer_id]);
    if (!customer) {
      return res.status(404).json({ message: 'حساب العميل غير موجود.' });
    }

    const refundAmount = Number(order.package_price || 0);
    if (refundAmount <= 0) {
      return res.status(400).json({ message: 'قيمة الطلب غير صالحة للاسترداد.' });
    }

    // Check if already refunded in wallet_transactions
    const existingRefund = await getQuery(
      "SELECT id FROM wallet_transactions WHERE customer_id = ? AND reference_type = 'order_refund' AND reference_id = ?",
      [customer.id, order.id]
    );
    if (existingRefund) {
      return res.status(400).json({ message: 'تم إرجاع قيمة هذا الطلب مسبقاً لمحفظة العميل.' });
    }

    const balanceBefore = Number(customer.balance || 0);
    const balanceAfter = balanceBefore + refundAmount;

    await runQuery('UPDATE customers SET balance = balance + ? WHERE id = ?', [refundAmount, customer.id]);
    await runQuery(
      'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        customer.id,
        customer.username,
        'credit',
        refundAmount,
        balanceBefore,
        balanceAfter,
        'order_refund',
        order.id,
        `استرداد يدوي لقيمة طلب شحن #${order.id}`
      ]
    );

    await runQuery("UPDATE orders SET status = 'cancelled', api_status = 'Refunded Manually' WHERE id = ?", [order.id]);

    // Telegram refund notification to customer
    if (order.customer_id) {
      ;(async () => {
        try {
          const customerTg = await getQuery('SELECT telegram_chat_id, username FROM customers WHERE id = ?', [order.customer_id]);
          if (customerTg && customerTg.telegram_chat_id) {
            const msg = [
              `💸 *تم إرجاع رصيد طلبك بنجاح!*`,
              `🛒 رقم الطلب: *#${order.id}*`,
              `🎮 الخدمة: *${order.service_name}*`,
              `💰 تم استرداد مبلغ *${refundAmount.toFixed(2)} USD* إلى محفظتك.`
            ].join('\n');
            await telegram.sendMessage(customerTg.telegram_chat_id, msg);
            console.log(`[Telegram Customer] Refund notification sent to ${customerTg.username || order.customer_id} ✓`);
          }
        } catch (err) {
          console.warn('[Telegram] Failed to send manual refund notification:', err.message);
        }
      })();
    }

    res.json({
      success: true,
      message: `تم إرجاع مبلغ $${refundAmount.toFixed(2)} لمحفظة العميل بنجاح.`,
      refund_amount: refundAmount,
      balance_after: balanceAfter
    });
  } catch (error) {
    console.error('Manual refund error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إرجاع الرصيد.' });
  }
});

module.exports = router;


