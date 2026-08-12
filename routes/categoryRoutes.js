const express = require('express');
const router = express.Router();
const { runQuery, allQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const deleteOtpAuth = require('../middleware/deleteOtpAuth');
const { saveImage } = require('../utils/imageSaver');

function safeParseJson(value, defaultValue = []) {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'object') {
    return value;
  }
  if (typeof value === 'string') {
    if (!value.trim()) return defaultValue;
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error('Error parsing JSON string:', value, e);
      return defaultValue;
    }
  }
  return defaultValue;
}

// Get menu categories (Public)
router.get('/menu', async (req, res) => {
  try {
    const categories = await allQuery('SELECT * FROM categories ORDER BY id ASC');
    const visibleCategories = categories.filter(cat => cat.show_in_menu === true || String(cat.show_in_menu) === '1' || String(cat.show_in_menu) === 'true');
    
    const formatted = visibleCategories.map(cat => ({
      id: cat.id,
      name: (cat.name || '').trim(),
      image: cat.image,
      parent_id: cat.parent_id,
      linked_categories: safeParseJson(cat.linked_categories)
    }));
    formatted.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    res.json(formatted);
  } catch (error) {
    console.error('Fetch menu categories error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب أقسام القائمة.' });
  }
});

// Get all categories (Public)
router.get('/', async (req, res) => {
  try {
    const categories = await allQuery('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
    const formatted = categories.map(cat => ({
      ...cat,
      name: (cat.name || '').trim(),
      fields: safeParseJson(cat.fields),
      show_in_menu: cat.show_in_menu === undefined || cat.show_in_menu === null ? false : !!cat.show_in_menu,
      is_featured: cat.is_featured === undefined || cat.is_featured === null ? false : !!cat.is_featured,
      cover_image: cat.cover_image || '',
      sort_order: Number(cat.sort_order || 0),
      linked_categories: safeParseJson(cat.linked_categories),
      parent_id: (cat.parent_id !== null && cat.parent_id !== undefined && cat.parent_id !== "") ? Number(cat.parent_id) : null
    }));
    formatted.sort((a, b) => {
      const orderA = a.sort_order || 0;
      const orderB = b.sort_order || 0;
      if (orderA !== orderB) {
        if (orderA === 0) return 1;
        if (orderB === 0) return -1;
        return orderA - orderB;
      }
      return a.name.localeCompare(b.name, 'ar');
    });
    res.json(formatted);
  } catch (error) {
    console.error('Fetch categories error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الأقسام.' });
  }
});

function removeDuplicateFields(fields) {
  if (!Array.isArray(fields)) return [];
  const seen = new Set();
  return fields.filter(field => {
    if (!field) return false;
    const fieldId = String(field.name || field.id || '').toLowerCase().trim();
    const fieldLabel = String(field.label || '').toLowerCase().trim();
    if (!fieldId && !fieldLabel) return false;
    
    const idKey = fieldId ? `id_${fieldId}` : null;
    const labelKey = fieldLabel ? `lbl_${fieldLabel}` : null;
    
    if ((idKey && seen.has(idKey)) || (labelKey && seen.has(labelKey))) {
      return false;
    }
    
    if (idKey) seen.add(idKey);
    if (labelKey) seen.add(labelKey);
    return true;
  });
}

// Add new category (Admin Protected)
router.post('/', authMiddleware, async (req, res) => {
  const { name, image, fields, fields_title, parent_id, linked_categories, is_featured, cover_image } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'اسم القسم مطلوب.' });
  }
  const finalName = name.trim();

  try {
    const savedImagePath = await saveImage(image);
    const finalImage = savedImagePath || 'default';
    
    let finalCoverImage = '';
    if (cover_image) {
      finalCoverImage = await saveImage(cover_image) || '';
    }
    
    const parsedFields = safeParseJson(fields);
    const cleanedFields = removeDuplicateFields(parsedFields);
    const fieldsStr = JSON.stringify(cleanedFields);

    const finalFieldsTitle = (fields_title && fields_title.trim()) ? fields_title.trim() : 'بيانات الخدمة';
    const finalParentId = (parent_id !== null && parent_id !== undefined && parent_id !== "" && parent_id !== "null" && Number(parent_id) !== 0) ? Number(parent_id) : null;
    
    const linkedStr = JSON.stringify(linked_categories || []);
    const isFeaturedBool = !!is_featured;

    const result = await runQuery(
      'INSERT INTO categories (name, image, fields, fields_title, parent_id, linked_categories, show_in_menu, is_featured, cover_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [finalName, finalImage, fieldsStr, finalFieldsTitle, finalParentId, linkedStr, false, isFeaturedBool, finalCoverImage]
    );
    res.status(201).json({
      message: 'تم إضافة القسم بنجاح.',
      id: result.lastID,
      name: finalName,
      image: finalImage,
      fields: safeParseJson(fieldsStr),
      fields_title: finalFieldsTitle,
      parent_id: finalParentId,
      linked_categories: safeParseJson(linked_categories),
      is_featured: isFeaturedBool,
      cover_image: finalCoverImage
    });
  } catch (error) {
    console.error('Add category error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ message: 'هذا القسم موجود بالفعل.' });
    }
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة القسم.' });
  }
});

// Bulk reorder categories (Admin Protected)
router.put('/reorder', authMiddleware, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ message: 'قائمة الترتيب غير صحيحة.' });
  }

  try {
    for (const item of items) {
      if (item.id !== undefined && item.sort_order !== undefined) {
        await runQuery('UPDATE categories SET sort_order = ? WHERE id = ?', [Number(item.sort_order), item.id]);
      }
    }
    res.json({ message: 'تم حفظ ترتيب الأقسام بنجاح.' });
  } catch (error) {
    console.error('Reorder categories error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تعديل ترتيب الأقسام.' });
  }
});

// Hide all categories from menu (Admin Protected)
router.put('/hide-all-menu', authMiddleware, async (req, res) => {
  try {
    await runQuery('UPDATE categories SET show_in_menu = false');
    res.json({ message: 'تم إخفاء جميع الأقسام بنجاح.' });
  } catch (error) {
    console.error('Hide all categories menu visibility error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إخفاء الأقسام.' });
  }
});

// Update category (Admin Protected)
router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, image, fields, fields_title, apply_to_services, parent_id, linked_categories, is_featured, cover_image } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'اسم القسم مطلوب للتحديث.' });
  }
  const finalName = name.trim();

  try {
    const finalImage = await saveImage(image);
    
    let finalCoverImage;
    if (cover_image !== undefined) {
      finalCoverImage = await saveImage(cover_image) || '';
    }
    
    const parsedFields = safeParseJson(fields);
    const cleanedFields = removeDuplicateFields(parsedFields);
    const fieldsStr = JSON.stringify(cleanedFields);

    const finalFieldsTitle = (fields_title && fields_title.trim()) ? fields_title.trim() : 'بيانات الخدمة';
    const finalParentId = (parent_id !== null && parent_id !== undefined && parent_id !== "" && parent_id !== "null" && Number(parent_id) !== 0 && Number(parent_id) !== Number(id)) ? Number(parent_id) : null;
    
    const linkedStr = JSON.stringify(linked_categories || []);
    const isFeaturedBool = !!is_featured;
    
    if (finalCoverImage !== undefined) {
      await runQuery(
        'UPDATE categories SET name = ?, image = ?, fields = ?, fields_title = ?, parent_id = ?, linked_categories = ?, is_featured = ?, cover_image = ? WHERE id = ?',
        [finalName, finalImage, fieldsStr, finalFieldsTitle, finalParentId, linkedStr, isFeaturedBool, finalCoverImage, id]
      );
    } else {
      await runQuery(
        'UPDATE categories SET name = ?, image = ?, fields = ?, fields_title = ?, parent_id = ?, linked_categories = ?, is_featured = ? WHERE id = ?',
        [finalName, finalImage, fieldsStr, finalFieldsTitle, finalParentId, linkedStr, isFeaturedBool, id]
      );
    }

    if (apply_to_services === true) {
      const { getDatabaseMode } = require('../db');
      if (getDatabaseMode().fallbackMode) {
        const fs = require('fs');
        const path = require('path');
        const dbPath = path.join(__dirname, '../database.json');
        if (fs.existsSync(dbPath)) {
          try {
            const { readDb, writeDb } = require('../db');
            const db = readDb();
            if (db.services) {
              db.services = db.services.map(s => {
                if (Number(s.category_id) === Number(id)) {
                  return {
                    ...s,
                    fields: safeParseJson(fieldsStr),
                    fields_title: finalFieldsTitle
                  };
                }
                return s;
              });
              writeDb(db);
            }
          } catch (err) {
            console.error('JSON bulk update services error:', err);
          }
        }
      } else {
        await runQuery(
          'UPDATE services SET fields = ?, fields_title = ? WHERE category_id = ?',
          [fieldsStr, finalFieldsTitle, id]
        );
      }
    }

    res.json({
      message: 'تم تحديث القسم بنجاح.',
      id,
      name,
      image: finalImage,
      fields: safeParseJson(fieldsStr),
      fields_title: finalFieldsTitle,
      parent_id: finalParentId
    });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث القسم.' });
  }
});

// Update category menu visibility (Admin Protected)
router.put('/:id/menu-visibility', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { show_in_menu } = req.body;

  if (typeof show_in_menu !== 'boolean') {
    return res.status(400).json({ message: 'قيمة الإظهار في القائمة غير صحيحة.' });
  }

  try {
    await runQuery('UPDATE categories SET show_in_menu = ? WHERE id = ?', [show_in_menu, id]);
    res.json({ message: 'تم تحديث حالة الظهور في القائمة بنجاح.', id, show_in_menu });
  } catch (error) {
    console.error('Update category menu visibility error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث القائمة.' });
  }
});

// Merge categories (Admin Protected)
router.post('/merge', authMiddleware, deleteOtpAuth, async (req, res) => {
  const { sourceIds, targetId } = req.body;

  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    return res.status(400).json({ message: 'يجب تحديد الأقسام المراد دمجها.' });
  }
  if (!targetId) {
    return res.status(400).json({ message: 'يجب تحديد القسم الهدف.' });
  }

  try {
    const { getDatabaseMode, allQuery, runQuery } = require('../db');
    
    if (getDatabaseMode().fallbackMode) {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '../database.json');
      if (fs.existsSync(dbPath)) {
        try {
          const { readDb, writeDb } = require('../db');
            const db = readDb();
          if (db.categories) {
            const targetCat = db.categories.find(c => Number(c.id) === Number(targetId));
            if (targetCat) {
              let currentLinked = safeParseJson(targetCat.linked_categories);
              const newLinked = Array.from(new Set([...currentLinked, ...sourceIds.map(String)]));
              targetCat.linked_categories = JSON.stringify(newLinked);
            }
          }
          writeDb(db);
        } catch (err) {
          console.error('JSON bulk merge categories error:', err);
        }
      }
    } else {
      // Get current linked_categories of targetId
      const targetCats = await allQuery('SELECT linked_categories FROM categories WHERE id = ?', [targetId]);
      if (targetCats.length > 0) {
        let currentLinked = safeParseJson(targetCats[0].linked_categories);
        const newLinked = Array.from(new Set([...currentLinked, ...sourceIds.map(String)]));
        await runQuery('UPDATE categories SET linked_categories = ? WHERE id = ?', [JSON.stringify(newLinked), targetId]);
      }
    }
    res.json({ message: 'تم تجميع الأقسام بنجاح دون إزالتها من مكانها الأصلي.' });
  } catch (error) {
    console.error('Merge categories error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء دمج الأقسام.' });
  }
});

// Delete all categories (Admin Protected)
router.delete('/all/clear', authMiddleware, deleteOtpAuth, async (req, res) => {
  try {
    await runQuery('DELETE FROM categories');
    
    const { getDatabaseMode } = require('../db');
    if (getDatabaseMode && getDatabaseMode().fallbackMode) {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '../database.json');
      if (fs.existsSync(dbPath)) {
        try {
          const { readDb, writeDb } = require('../db');
            const db = readDb();
          db.categories = [];
          writeDb(db);
        } catch (err) {
          console.error('JSON bulk delete categories error:', err);
        }
      }
    }

    res.json({ message: 'تم حذف جميع الأقسام بنجاح.' });
  } catch (error) {
    console.error('Delete all categories error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف جميع الأقسام.' });
  }
});

// Delete category (Admin Protected)
router.delete('/:id', authMiddleware, deleteOtpAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { getDatabaseMode } = require('../db');
    if (getDatabaseMode().fallbackMode) {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '../database.json');
      if (fs.existsSync(dbPath)) {
        try {
          const { readDb, writeDb } = require('../db');
            const db = readDb();
          if (db.categories) {
            db.categories = db.categories.map(c => {
              if (Number(c.parent_id) === Number(id)) {
                return { ...c, parent_id: null };
              }
              return c;
            });
            writeDb(db);
          }
        } catch (err) {
          console.error('JSON update child categories error:', err);
        }
      }
    } else {
      try {
        await runQuery('UPDATE categories SET parent_id = NULL WHERE parent_id = ?', [id]);
      } catch (err) {
        console.error('SQL update child categories error:', err);
      }
    }
    await runQuery('DELETE FROM categories WHERE id = ?', [id]);
    res.json({ message: 'تم حذف القسم والخدمات التابعة له بنجاح.', id });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف القسم.' });
  }
});

module.exports = router;
