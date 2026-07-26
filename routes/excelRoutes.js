const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { runQuery, allQuery, getQuery } = require('../db');
const authMiddleware = require('../middleware/auth');

// Helper to save base64 file to temp directory
function saveBase64Excel(base64Data, filename) {
  const matches = base64Data.match(/^data:.+;base64,(.+)$/);
  if (!matches || matches.length !== 2) {
    throw new Error('بيانات ملف الإكسل غير صالحة.');
  }
  const dataBuffer = Buffer.from(matches[1], 'base64');
  const tempDir = path.join(__dirname, '../uploads/temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const fullPath = path.join(tempDir, filename);
  fs.writeFileSync(fullPath, dataBuffer);
  return fullPath;
}

// Helper to run python script
function parseExcelWithPython(filePath) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, '../utils/process_excel.py');
    exec(`python "${pythonScript}" "${filePath}"`, { maxBuffer: 15 * 1024 * 1024 }, (error, stdout, stderr) => {
      // Clean up the uploaded temp file
      try { fs.unlinkSync(filePath); } catch (e) {}

      if (error) {
        console.error('Python parse error:', stderr || error.message);
        return reject(new Error(`فشل معالجة الملف بواسطة بايثون: ${error.message}`));
      }

      try {
        const data = JSON.parse(stdout);
        if (data.error) {
          return reject(new Error(data.error));
        }
        resolve(data);
      } catch (e) {
        console.error('JSON parse error on stdout:', stdout);
        reject(new Error(`فشل قراءة مخرجات معالجة الملف: ${e.message}`));
      }
    });
  });
}

// Get excel settings (USD rate & Markups)
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    const settingsList = await allQuery('SELECT * FROM settings WHERE key IN (?, ?, ?, ?)', [
      'apple_usd_rate', 'apple_markup', 'frp_usd_rate', 'frp_markup'
    ]);
    
    const settings = {};
    settingsList.forEach(item => {
      settings[item.key] = item.value;
    });

    res.json({
      apple_usd_rate: parseFloat(settings.apple_usd_rate) || 1.0,
      apple_markup: parseFloat(settings.apple_markup) || 10.0,
      frp_usd_rate: parseFloat(settings.frp_usd_rate) || 1.0,
      frp_markup: parseFloat(settings.frp_markup) || 10.0
    });
  } catch (error) {
    console.error('Get excel settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب إعدادات الأسعار.' });
  }
});

// Update excel settings & recalculate EGP prices in database
router.put('/settings', authMiddleware, async (req, res) => {
  const { apple_usd_rate, apple_markup, frp_usd_rate, frp_markup } = req.body;

  try {
    const updates = [
      { key: 'apple_usd_rate', value: String(parseFloat(apple_usd_rate) || 1.0) },
      { key: 'apple_markup', value: String(parseFloat(apple_markup) || 0.0) },
      { key: 'frp_usd_rate', value: String(parseFloat(frp_usd_rate) || 1.0) },
      { key: 'frp_markup', value: String(parseFloat(frp_markup) || 0.0) }
    ];

    for (const item of updates) {
      const existing = await getQuery('SELECT * FROM settings WHERE key = ?', [item.key]);
      if (existing) {
        await runQuery('UPDATE settings SET value = ? WHERE key = ?', [item.value, item.key]);
      } else {
        await runQuery('INSERT INTO settings (key, value) VALUES (?, ?)', [item.key, item.value]);
      }
    }

    // Now recalculate EGP prices for Apple Services
    const appleCategory = await getQuery("SELECT id FROM categories WHERE name = 'خدمات APPLE'");
    if (appleCategory) {
      const rate = parseFloat(apple_usd_rate) || 1.0;
      const markup = parseFloat(apple_markup) || 0.0;
      await recalculateCategoryPrices(appleCategory.id, rate, markup);
    }

    // Recalculate EGP prices for FRP Services
    const frpCategory = await getQuery("SELECT id FROM categories WHERE name = 'خدمات سيرفر FRP'");
    if (frpCategory) {
      const rate = parseFloat(frp_usd_rate) || 1.0;
      const markup = parseFloat(frp_markup) || 0.0;
      await recalculateCategoryPrices(frpCategory.id, rate, markup);
    }

    res.json({ message: 'تم تحديث الإعدادات وإعادة حساب الأسعار بنجاح.' });
  } catch (error) {
    console.error('Update excel settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حفظ الإعدادات وتحديث الأسعار.' });
  }
});

// Upload and Import Excel
router.post('/upload', authMiddleware, async (req, res) => {
  const { file_name, file_data, type } = req.body; // type: 'apple' or 'frp'

  if (!file_name || !file_data || !type) {
    return res.status(400).json({ message: 'البيانات المرسلة غير مكتملة.' });
  }

  try {
    // 1. Get rates/markups from DB
    const settingsList = await allQuery('SELECT * FROM settings WHERE key IN (?, ?, ?, ?)', [
      'apple_usd_rate', 'apple_markup', 'frp_usd_rate', 'frp_markup'
    ]);
    const settings = {};
    settingsList.forEach(item => {
      settings[item.key] = item.value;
    });

    const usdRate = type === 'apple' 
      ? (parseFloat(settings.apple_usd_rate) || 1.0) 
      : (parseFloat(settings.frp_usd_rate) || 1.0);
    const markup = type === 'apple' 
      ? (parseFloat(settings.apple_markup) || 10.0) 
      : (parseFloat(settings.frp_markup) || 10.0);

    const categoryName = type === 'apple' ? 'خدمات APPLE' : 'خدمات سيرفر FRP';
    const categoryColor = type === 'apple' ? '#a855f7' : '#10b981';
    const categoryIcon = type === 'apple' ? 'apple' : 'cpu';

    // 2. Save the uploaded file temporarily
    const tempFilePath = saveBase64Excel(file_data, `upload_${type}_${Date.now()}.xlsx`);

    // 3. Process the file using Python script
    const parsedServices = await parseExcelWithPython(tempFilePath);

    // 4. Ensure category exists in DB (with currency = 'USD')
    let category = await getQuery('SELECT * FROM categories WHERE name = ?', [categoryName]);
    let categoryId;
    if (!category) {
      const result = await runQuery(
        'INSERT INTO categories (name, image, color, icon, currency) VALUES (?, ?, ?, ?, ?)',
        [categoryName, 'default', categoryColor, categoryIcon, 'USD']
      );
      categoryId = result.lastID;
    } else {
      categoryId = category.id;
      // Ensure the currency is updated to USD just in case
      await runQuery('UPDATE categories SET currency = ? WHERE id = ?', ['USD', categoryId]);
    }

    // 5. Delete existing services in this category to prevent duplicates
    await runQuery('DELETE FROM services WHERE category_id = ?', [categoryId]);

    // 6. Import all services and packages
    for (const s of parsedServices) {
      // Recalculate packages prices
      const recalculatedPackages = s.packages.map(pkg => {
        const finalEgpPrice = pkg.usd_price * usdRate * (1 + markup / 100);
        return {
          id: pkg.id,
          name: pkg.name,
          usd_price: pkg.usd_price,
          price: parseFloat(finalEgpPrice.toFixed(2)),
          status: pkg.status
        };
      });

      const minPrice = recalculatedPackages.reduce((min, p) => p.price < min ? p.price : min, parseFloat((s.price * usdRate * (1 + markup / 100)).toFixed(2)));

      const defaultFields = [
        { name: "player_id", label: "معرّف الحساب / السيريال (Serial / ID)", placeholder: "أدخل رقم الحساب أو السيريال بدقة هنا", type: "text", required: true }
      ];

      await runQuery(
        'INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          categoryId,
          s.name,
          s.description,
          minPrice,
          'default',
          JSON.stringify(recalculatedPackages),
          JSON.stringify(defaultFields),
          'fixed',
          0.0
        ]
      );
    }

    res.json({
      message: `تم استيراد ${parsedServices.length} خدمة بنجاح في قسم ${categoryName}.`
    });

  } catch (error) {
    console.error('Upload excel error:', error);
    res.status(500).json({ message: error.message || 'حدث خطأ أثناء معالجة واستيراد ملف الإكسل.' });
  }
});

// Helper function to recalculate prices for all services in a category
async function recalculateCategoryPrices(categoryId, usdRate, markup) {
  const services = await allQuery('SELECT * FROM services WHERE category_id = ?', [categoryId]);
  
  for (const service of services) {
    let packages = [];
    try {
      packages = typeof service.packages === 'string' ? JSON.parse(service.packages) : (service.packages || []);
    } catch (e) {
      continue;
    }

    if (!Array.isArray(packages) || packages.length === 0) continue;

    const recalculated = packages.map(pkg => {
      const usdPrice = pkg.usd_price || 0.0;
      const finalEgpPrice = usdPrice * usdRate * (1 + markup / 100);
      return {
        ...pkg,
        price: parseFloat(finalEgpPrice.toFixed(2))
      };
    });

    const minPrice = recalculated.reduce((min, p) => p.price < min ? p.price : min, recalculated[0].price);

    await runQuery('UPDATE services SET price = ?, packages = ? WHERE id = ?', [
      minPrice,
      JSON.stringify(recalculated),
      service.id
    ]);
  }
}

module.exports = router;
