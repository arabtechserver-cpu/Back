const express = require('express');
const router = express.Router();
const { runQuery, allQuery, getQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../utils/security');

// Helper to check admin
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

// GET /api/reviews - Public endpoint to get all reviews
router.get('/', async (req, res) => {
  try {
    const reviews = await allQuery('SELECT * FROM reviews ORDER BY id DESC');
    res.json(reviews || []);
  } catch (error) {
    console.error('Fetch reviews error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الآراء.' });
  }
});

// POST /api/reviews - Add a new review (Admin only)
router.post('/', authMiddleware, async (req, res) => {
  const { name, review, rating, country_code } = req.body;

  if (!name || !review) {
    return res.status(400).json({ message: 'حقول الاسم والرأي مطلوبة.' });
  }

  try {
    const isAdmin = await checkIsAdmin(req);
    if (!isAdmin) {
      return res.status(403).json({ message: 'غير مصرح لك بإضافة آراء.' });
    }

    const result = await runQuery(
      'INSERT INTO reviews (name, review, rating, country_code) VALUES (?, ?, ?, ?)',
      [name, review, rating || 5, country_code || 'EG']
    );

    res.status(201).json({
      message: 'تم إضافة الرأي بنجاح.',
      id: result.lastID,
      name,
      review,
      rating: rating || 5,
      country_code: country_code || 'EG'
    });
  } catch (error) {
    console.error('Add review error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة الرأي.' });
  }
});

// DELETE /api/reviews/:id - Delete a review (Admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const isAdmin = await checkIsAdmin(req);
    if (!isAdmin) {
      return res.status(403).json({ message: 'غير مصرح لك بحذف آراء.' });
    }

    await runQuery('DELETE FROM reviews WHERE id = ?', [id]);
    res.json({ message: 'تم حذف الرأي بنجاح.' });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف الرأي.' });
  }
});

module.exports = router;
