const express = require('express');
const router = express.Router();
const { allQuery, getQuery, runQuery } = require('../db');
const authMiddleware = require('../middleware/auth');

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
        'UPDATE customers SET balance = balance + ?, total_deposited = COALESCE(total_deposited, 0) + ?, balances = ? WHERE id = ?',
        [amountInBase, amountInBase, JSON.stringify({}), request.customer_id]
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

module.exports = router;
