const express = require('express');
const router = express.Router();
const { runQuery, allQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const deleteOtpAuth = require('../middleware/deleteOtpAuth');
const { saveImage } = require('../utils/imageSaver');

// Get all banners (Public)
router.get('/', async (req, res) => {
  try {
    const banners = await allQuery('SELECT id, title, highlight, description AS desc, badge, color, icon FROM banners ORDER BY id ASC');
    res.json(banners);
  } catch (error) {
    console.error('Fetch banners error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب شرائح البانر.' });
  }
});

// Add new banner (Admin Protected)
router.post('/', authMiddleware, async (req, res) => {
  const { title, highlight, desc, badge, color, icon } = req.body;

  if (!title) {
    return res.status(400).json({ message: 'العنوان مطلوب.' });
  }

  try {
    const savedImagePath = saveImage(icon);
    const finalIcon = savedImagePath || '⚡';
    const result = await runQuery(
      'INSERT INTO banners (title, highlight, description, badge, color, icon) VALUES (?, ?, ?, ?, ?, ?)',
      [title, highlight || '', desc || '', badge || '', color || '#8b5cf6', finalIcon]
    );
    res.status(201).json({
      message: 'تم إضافة شريحة البانر بنجاح.',
      id: result.lastID,
      title,
      highlight,
      desc,
      badge,
      color,
      icon: finalIcon
    });
  } catch (error) {
    console.error('Add banner error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة شريحة البانر.' });
  }
});

// Update banner (Admin Protected)
router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, highlight, desc, badge, color, icon } = req.body;

  if (!title) {
    return res.status(400).json({ message: 'العنوان مطلوب للتحديث.' });
  }

  try {
    const finalIcon = saveImage(icon);
    await runQuery(
      'UPDATE banners SET title = ?, highlight = ?, description = ?, badge = ?, color = ?, icon = ? WHERE id = ?',
      [title, highlight, desc, badge, color, finalIcon, id]
    );
    res.json({ message: 'تم تحديث شريحة البانر بنجاح.', id, title, highlight, desc, badge, color, icon: finalIcon });
  } catch (error) {
    console.error('Update banner error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث شريحة البانر.' });
  }
});

// Delete banner (Admin Protected)
router.delete('/:id', authMiddleware, deleteOtpAuth, async (req, res) => {
  const { id } = req.params;

  try {
    await runQuery('DELETE FROM banners WHERE id = ?', [id]);
    res.json({ message: 'تم حذف شريحة البانر بنجاح.', id });
  } catch (error) {
    console.error('Delete banner error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف شريحة البانر.' });
  }
});

module.exports = router;
