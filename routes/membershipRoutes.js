const express = require('express');
const router = express.Router();
const { runQuery, allQuery, getQuery } = require('../db');
const authMiddleware = require('../middleware/auth');

// Helper to check admin
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../utils/security');
const checkIsAdmin = async (req) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return false;
    const token = authHeader.split(' ')[1];
    if (!token) return false;
    const decoded = jwt.verify(token, getJwtSecret());
    const adminUser = await getQuery('SELECT id FROM users WHERE id = ? AND username = ?', [decoded.id, decoded.username]);
    return !!adminUser;
  } catch (e) {
    return false;
  }
};

// Admin middleware
const adminAuth = async (req, res, next) => {
  const isAdmin = await checkIsAdmin(req);
  if (!isAdmin) {
    return res.status(403).json({ message: 'غير مصرح لك بالوصول (صلاحيات مسؤول فقط).' });
  }
  next();
};

// GET all membership tiers
router.get('/tiers', adminAuth, async (req, res) => {
  try {
    const tiers = await allQuery('SELECT * FROM membership_tiers ORDER BY condition_value ASC') || [];
    res.json(tiers);
  } catch (error) {
    console.error('Fetch membership tiers error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب مستويات العضوية.' });
  }
});

// CREATE a membership tier
router.post('/tiers', adminAuth, async (req, res) => {
  const { name, condition_type, condition_value, icon, color } = req.body;
  if (!name || name.trim() === '') return res.status(400).json({ message: 'اسم العضوية مطلوب.' });
  
  try {
    const result = await runQuery(
      'INSERT INTO membership_tiers (name, condition_type, condition_value, icon, color) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), condition_type || 'total_deposited', condition_value || 0, icon || '⭐', color || '#fbbf24']
    );
    res.json({ message: 'تم إنشاء العضوية بنجاح.', id: result.lastID });
  } catch (error) {
    console.error('Create membership tier error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إنشاء العضوية.' });
  }
});

// UPDATE a membership tier
router.put('/tiers/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, condition_type, condition_value, icon, color } = req.body;
  
  try {
    await runQuery(
      'UPDATE membership_tiers SET name = ?, condition_type = ?, condition_value = ?, icon = ?, color = ? WHERE id = ?',
      [name, condition_type, condition_value, icon, color, id]
    );
    res.json({ message: 'تم تحديث العضوية بنجاح.' });
  } catch (error) {
    console.error('Update membership tier error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث العضوية.' });
  }
});

// DELETE a membership tier
router.delete('/tiers/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await runQuery('DELETE FROM membership_tiers WHERE id = ?', [id]);
    res.json({ message: 'تم حذف العضوية بنجاح.' });
  } catch (error) {
    console.error('Delete membership tier error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف العضوية.' });
  }
});

// GET all discounts for a tier
router.get('/tiers/:id/discounts', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const discounts = await allQuery('SELECT * FROM membership_discounts WHERE tier_id = ? ORDER BY id DESC', [id]) || [];
    res.json(discounts);
  } catch (error) {
    console.error('Fetch membership discounts error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الخصومات.' });
  }
});

// CREATE a discount for a tier
router.post('/tiers/:id/discounts', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { target_type, target_id, discount_type, discount_value } = req.body;
  
  try {
    const result = await runQuery(
      'INSERT INTO membership_discounts (tier_id, target_type, target_id, discount_type, discount_value) VALUES (?, ?, ?, ?, ?)',
      [id, target_type || 'global', target_id || null, discount_type || 'percentage', discount_value || 0]
    );
    res.json({ message: 'تم إضافة الخصم بنجاح.', id: result.lastID });
  } catch (error) {
    console.error('Create membership discount error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة الخصم.' });
  }
});

// DELETE a discount from a tier
router.delete('/discounts/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await runQuery('DELETE FROM membership_discounts WHERE id = ?', [id]);
    res.json({ message: 'تم حذف الخصم بنجاح.' });
  } catch (error) {
    console.error('Delete membership discount error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف الخصم.' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Manual User Membership Assignment
// ──────────────────────────────────────────────────────────────────────

// GET all members assigned to a specific tier (with customer info)
router.get('/tiers/:id/members', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const members = await allQuery(
      'SELECT um.*, c.username, c.email, c.phone, c.balance FROM user_memberships um LEFT JOIN customers c ON um.customer_id = c.id WHERE um.tier_id = ? ORDER BY um.id DESC',
      [id]
    );

    // Fallback: if JOIN doesn't work in JSON mode, manually merge
    if (members && members.length > 0 && !members[0].username) {
      const customers = await allQuery('SELECT * FROM customers');
      const customerMap = {};
      if (customers) {
        for (const c of customers) {
          customerMap[c.id] = c;
        }
      }
      const enriched = members.map(m => {
        const c = customerMap[m.customer_id] || {};
        return { ...m, username: c.username || '', email: c.email || '', phone: c.phone || '', balance: Number(c.balance || 0) };
      });
      return res.json(enriched);
    }

    res.json(members || []);
  } catch (error) {
    console.error('Fetch tier members error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب أعضاء العضوية.' });
  }
});

// ASSIGN a customer to a tier manually
router.post('/tiers/:id/members', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { customer_id, notes } = req.body;

  if (!customer_id) {
    return res.status(400).json({ message: 'يرجى تحديد المستخدم المراد إضافته.' });
  }

  try {
    // Check tier exists
    const tier = await getQuery('SELECT * FROM membership_tiers WHERE id = ?', [id]);
    if (!tier) return res.status(404).json({ message: 'مستوى العضوية غير موجود.' });

    // Check customer exists
    const customer = await getQuery('SELECT * FROM customers WHERE id = ?', [customer_id]);
    if (!customer) return res.status(404).json({ message: 'المستخدم غير موجود.' });

    // Check if already assigned
    const existing = await getQuery('SELECT * FROM user_memberships WHERE customer_id = ? AND tier_id = ?', [customer_id, id]);
    if (existing) {
      return res.status(400).json({ message: `المستخدم "${customer.username}" مُضاف بالفعل في عضوية "${tier.name}".` });
    }

    const result = await runQuery(
      'INSERT INTO user_memberships (customer_id, tier_id, assigned_by, notes) VALUES (?, ?, ?, ?)',
      [customer_id, id, 'admin', notes || '']
    );

    res.status(201).json({
      message: `تم إضافة "${customer.username}" إلى عضوية "${tier.name}" بنجاح.`,
      id: result.lastID,
      member: {
        id: result.lastID,
        customer_id: Number(customer_id),
        tier_id: Number(id),
        username: customer.username,
        email: customer.email || '',
        phone: customer.phone || '',
        balance: Number(customer.balance || 0),
        notes: notes || '',
        assigned_by: 'admin'
      }
    });
  } catch (error) {
    console.error('Assign member to tier error:', error);
    if (error.message && error.message.includes('UNIQUE')) {
      return res.status(400).json({ message: 'المستخدم مُضاف بالفعل في هذه العضوية.' });
    }
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة المستخدم للعضوية.' });
  }
});

// REMOVE a customer from a tier
router.delete('/members/:membershipId', adminAuth, async (req, res) => {
  const { membershipId } = req.params;
  try {
    await runQuery('DELETE FROM user_memberships WHERE id = ?', [membershipId]);
    res.json({ message: 'تم إزالة المستخدم من العضوية بنجاح.' });
  } catch (error) {
    console.error('Remove member from tier error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إزالة المستخدم من العضوية.' });
  }
});

// GET all manual memberships for a specific customer (used by /me endpoint)
router.get('/customer/:customerId', async (req, res) => {
  const { customerId } = req.params;
  try {
    const memberships = await allQuery(
      'SELECT um.*, mt.name as tier_name, mt.icon as tier_icon, mt.color as tier_color FROM user_memberships um LEFT JOIN membership_tiers mt ON um.tier_id = mt.id WHERE um.customer_id = ? ORDER BY um.id DESC',
      [customerId]
    );

    // Fallback for JSON mode
    if (memberships && memberships.length > 0 && !memberships[0].tier_name) {
      const tiers = await allQuery('SELECT * FROM membership_tiers');
      const tierMap = {};
      if (tiers) {
        for (const t of tiers) {
          tierMap[t.id] = t;
        }
      }
      const enriched = memberships.map(m => {
        const t = tierMap[m.tier_id] || {};
        return { ...m, tier_name: t.name || '', tier_icon: t.icon || '⭐', tier_color: t.color || '#fbbf24' };
      });
      return res.json(enriched);
    }

    res.json(memberships || []);
  } catch (error) {
    console.error('Fetch customer memberships error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب عضويات المستخدم.' });
  }
});

module.exports = router;
