const express = require('express');
const router = express.Router();
const { allQuery, getQuery, runQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const paypal = require('../services/paypalService');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const requests = await allQuery('SELECT * FROM wallet_requests ORDER BY id DESC');
    res.json(requests);
  } catch (error) {
    console.error('Fetch wallet requests error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب طلبات الشحن.' });
  }
});

router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const transactions = await allQuery('SELECT * FROM wallet_transactions ORDER BY id DESC');
    res.json(transactions);
  } catch (error) {
    console.error('Fetch wallet transactions error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب سجل المحفظة.' });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status, admin_note } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'حالة الطلب غير صالحة.' });
  }

  try {
    const request = await getQuery('SELECT * FROM wallet_requests WHERE id = ?', [id]);
    if (!request) {
      return res.status(404).json({ message: 'طلب الشحن غير موجود.' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'تم التعامل مع هذا الطلب مسبقاً.' });
    }

    // ATOMIC: Update status first with conditional WHERE to prevent double-processing
    const updateResult = await runQuery(
      'UPDATE wallet_requests SET status = ?, admin_note = ?, processed_at = ? WHERE id = ? AND status = ?',
      [status, admin_note || '', new Date().toISOString(), request.id, 'pending']
    );

    // Check if the row was actually updated (race condition guard)
    const affectedRows = updateResult?.changes ?? updateResult?.rowCount ?? 1;
    if (affectedRows === 0) {
      return res.status(400).json({ message: 'تم التعامل مع هذا الطلب مسبقاً بواسطة مسؤول آخر.' });
    }

    if (status === 'approved') {
      const customerBefore = await getQuery('SELECT * FROM customers WHERE id = ?', [request.customer_id]);
      const balanceBefore = Number(customerBefore?.balance || 0);
      const reqCurrency = request.currency || 'USD';

      const amountInBase = Number(request.amount || 0);
      const balanceAfter = balanceBefore + amountInBase;

      // Update main balance and total_deposited
      await runQuery(
        'UPDATE customers SET balance = balance + ?, total_deposited = COALESCE(total_deposited, 0) + ? WHERE id = ?',
        [amountInBase, amountInBase, request.customer_id]
      );

      // Record transaction
      await runQuery(
        'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          request.customer_id,
          request.customer_username,
          'credit',
          amountInBase,
          balanceBefore,
          balanceAfter,
          'wallet_request',
          request.id,
          `شحن محفظة بقيمة ${amountInBase} USDT (عبر دفع عملة ${reqCurrency}) لطلب رقم #${request.id}`
        ]
      );
    }

    const updatedRequest = await getQuery('SELECT * FROM wallet_requests WHERE id = ?', [request.id]);
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [request.customer_id]);

    res.json({
      message: status === 'approved' ? 'تم اعتماد شحن الرصيد وإضافة المبلغ للمحفظة.' : 'تم رفض طلب الشحن.',
      request: updatedRequest,
      customer: customer ? {
        id: customer.id,
        username: customer.username,
        balance: Number(customer.balance || 0)
      } : null
    });
  } catch (error) {
    console.error('Update wallet request error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث طلب الشحن.' });
  }
});

// ── PayPal Routes ─────────────────────────────────────────────────────────────

/**
 * POST /api/wallet/paypal/create-order
 * Creates a PayPal order and returns the approval URL
 */
router.post('/paypal/create-order', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ message: 'يرجى إدخال مبلغ صحيح.' });
    }
    if (parsedAmount < 1) {
      return res.status(400).json({ message: 'الحد الأدنى للشحن عبر PayPal هو 1 دولار.' });
    }

    const returnUrl = `${process.env.PAYPAL_RETURN_URL || 'https://arab-tech1.online/wallet'}?paypal=success`;
    const cancelUrl = `${process.env.PAYPAL_CANCEL_URL || 'https://arab-tech1.online/wallet'}?paypal=cancel`;

    const order = await paypal.createOrder(parsedAmount, returnUrl, cancelUrl);

    res.json({
      orderId: order.id,
      approvalUrl: order.approvalUrl,
      amount: parsedAmount,
    });
  } catch (error) {
    console.error('[PayPal] create-order error:', error);
    res.status(500).json({ message: error.message || 'فشل إنشاء طلب PayPal.' });
  }
});

/**
 * POST /api/wallet/paypal/capture-order
 * Captures an approved PayPal order and credits the customer's wallet
 */
router.post('/paypal/capture-order', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    const customerId = req.user?.id || req.user?.customer_id;

    if (!orderId) {
      return res.status(400).json({ message: 'معرف الطلب مطلوب.' });
    }
    if (!customerId) {
      return res.status(401).json({ message: 'المستخدم غير مصادق عليه.' });
    }

    // Check if this PayPal order was already processed (prevent double-capture)
    const existingRequest = await getQuery(
      "SELECT * FROM wallet_requests WHERE notes LIKE ? AND status = 'approved'",
      [`%paypal_order:${orderId}%`]
    );
    if (existingRequest) {
      return res.status(400).json({ message: 'تم معالجة هذه العملية مسبقاً.' });
    }

    // Capture the payment from PayPal
    const capture = await paypal.captureOrder(orderId);

    if (capture.status !== 'COMPLETED') {
      return res.status(400).json({
        message: `حالة الدفع: ${capture.status}. يرجى المحاولة مجدداً.`,
      });
    }

    const capturedAmount = parseFloat(capture.amount);
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (!customer) {
      return res.status(404).json({ message: 'المستخدم غير موجود.' });
    }

    const balanceBefore = Number(customer.balance || 0);
    const balanceAfter = balanceBefore + capturedAmount;

    // Record the wallet request as approved
    const insertResult = await runQuery(
      `INSERT INTO wallet_requests (customer_id, customer_username, amount, currency, sender_phone, notes, status, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)`,
      [
        customerId,
        customer.username,
        capturedAmount,
        'USD',
        capture.payerEmail || 'PayPal',
        `دفع تلقائي عبر PayPal | paypal_order:${orderId} | capture:${capture.captureId} | payer:${capture.payerName} (${capture.payerEmail})`,
        new Date().toISOString(),
      ]
    );

    const requestId = insertResult?.lastID || insertResult?.rows?.[0]?.id || insertResult?.id;

    // Credit the customer's wallet
    await runQuery(
      'UPDATE customers SET balance = balance + ?, total_deposited = COALESCE(total_deposited, 0) + ? WHERE id = ?',
      [capturedAmount, capturedAmount, customerId]
    );

    // Record transaction
    await runQuery(
      `INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        customer.username,
        'credit',
        capturedAmount,
        balanceBefore,
        balanceAfter,
        'paypal',
        requestId || orderId,
        `شحن محفظة بقيمة $${capturedAmount} USD عبر PayPal (Order: ${orderId})`,
      ]
    );

    const updatedCustomer = await getQuery('SELECT * FROM customers WHERE id = ?', [customerId]);

    res.json({
      message: `تم الدفع وشحن رصيدك بمبلغ $${capturedAmount} USD بنجاح! ✅`,
      amount: capturedAmount,
      balance: Number(updatedCustomer?.balance || balanceAfter),
      captureId: capture.captureId,
      orderId,
    });
  } catch (error) {
    console.error('[PayPal] capture-order error:', error);
    res.status(500).json({ message: error.message || 'فشل تأكيد الدفع.' });
  }
});

module.exports = router;
