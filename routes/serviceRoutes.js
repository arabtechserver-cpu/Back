const express = require('express');
const router = express.Router();
const { runQuery, allQuery, getQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const deleteOtpAuth = require('../middleware/deleteOtpAuth');
const { saveImage } = require('../utils/imageSaver');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../utils/security');

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

const getCustomerIdFromRequest = (req) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return null;
    const token = authHeader.split(' ')[1];
    if (!token) return null;
    const decoded = jwt.verify(token, getJwtSecret());
    if (decoded.role !== 'customer') return null;
    return decoded.id;
  } catch (e) {
    return null;
  }
};

const applyCustomerDiscounts = async (customerId, formattedServices) => {
  if (!customerId) return formattedServices;
  try {
    // 1. Fetch manual customer discounts
    const directDiscounts = await allQuery(
      'SELECT * FROM customer_discounts WHERE customer_id = ? AND is_active = ?',
      [customerId, true]
    ) || [];

    const now = new Date();
    const activeDirectDiscounts = directDiscounts.filter(d => {
      if (!d.expires_at) return true;
      return new Date(d.expires_at) > now;
    });

    // 2. Fetch customer progress
    const customer = await getQuery('SELECT total_deposited FROM customers WHERE id = ?', [customerId]);
    const orderCountRow = await getQuery('SELECT COUNT(*) as count FROM orders WHERE customer_id = ?', [customerId]);
    
    const totalDeposited = Number(customer?.total_deposited || 0);
    const totalOrders = Number(orderCountRow ? orderCountRow.count : 0);

    // 3. Fetch membership tiers
    const allTiers = (await allQuery('SELECT * FROM membership_tiers')) || [];
    const autoTierIds = allTiers.filter(tier => {
      if (tier.condition_type === 'total_orders') {
        return totalOrders >= Number(tier.condition_value);
      } else if (tier.condition_type === 'total_deposited') {
        return totalDeposited >= Number(tier.condition_value);
      }
      return false;
    }).map(t => Number(t.id));

    // Fetch manually assigned tiers
    const manualMemberships = await allQuery('SELECT tier_id FROM user_memberships WHERE customer_id = ?', [customerId]) || [];
    const manualTierIds = manualMemberships.map(m => Number(m.tier_id));

    // Combine both sets
    const activeTierIds = Array.from(new Set([...autoTierIds, ...manualTierIds]));

    // 4. Fetch membership discounts for active tiers
    let membershipDiscounts = [];
    if (activeTierIds.length > 0) {
      const placeholders = activeTierIds.map(() => '?').join(',');
      membershipDiscounts = await allQuery(
        `SELECT * FROM membership_discounts WHERE tier_id IN (${placeholders})`,
        activeTierIds
      ) || [];
    }

    if (activeDirectDiscounts.length === 0 && membershipDiscounts.length === 0) {
      return formattedServices;
    }

    const applyVal = (val, type, amount) => {
      if (type === 'percentage') {
        return parseFloat((val * (1 - amount / 100)).toFixed(2));
      } else if (type === 'fixed') {
        return Math.max(0, parseFloat((val - amount).toFixed(2)));
      }
      return val;
    };

    return formattedServices.map(service => {
      // Find all applicable discounts for this service
      let applicableDiscounts = [];

      // Add direct discounts
      const dService = activeDirectDiscounts.find(d => Number(d.service_id) === Number(service.id));
      const dCategory = activeDirectDiscounts.find(d => !d.service_id && Number(d.category_id) === Number(service.category_id));
      const dGlobal = activeDirectDiscounts.find(d => !d.service_id && !d.category_id);
      
      if (dService) applicableDiscounts.push({ ...dService, description: dService.description || 'خصم خاص' });
      else if (dCategory) applicableDiscounts.push({ ...dCategory, description: dCategory.description || 'خصم قسم' });
      else if (dGlobal) applicableDiscounts.push({ ...dGlobal, description: dGlobal.description || 'خصم عام' });

      // Add membership discounts
      const mService = membershipDiscounts.filter(d => d.target_type === 'service' && Number(d.target_id) === Number(service.id));
      const mCategory = membershipDiscounts.filter(d => d.target_type === 'category' && Number(d.target_id) === Number(service.category_id));
      const mGlobal = membershipDiscounts.filter(d => d.target_type === 'global');
      
      [...mService, ...mCategory, ...mGlobal].forEach(d => {
        applicableDiscounts.push({ ...d, description: 'خصم عضوية' });
      });

      if (applicableDiscounts.length === 0) return service;

      // Find best discount (the one that results in the lowest price)
      let bestDiscount = null;
      let lowestPrice = service.price;

      applicableDiscounts.forEach(d => {
        const testPrice = applyVal(service.price, d.discount_type, d.discount_value);
        if (testPrice < lowestPrice || bestDiscount === null) {
          lowestPrice = testPrice;
          bestDiscount = d;
        }
      });

      if (!bestDiscount) return service;

      const discount = bestDiscount;
      const updatedPrice = applyVal(service.price, discount.discount_type, discount.discount_value);
      const updatedPricePerThousand = applyVal(service.price_per_thousand, discount.discount_type, discount.discount_value);
      const updatedPackages = (service.packages || []).map(pkg => ({
        ...pkg,
        price: applyVal(pkg.price, discount.discount_type, discount.discount_value),
        original_price: pkg.price,
        discount_value: discount.discount_value,
        discount_type: discount.discount_type,
        discount_description: discount.description
      }));

      return {
        ...service,
        price: updatedPrice,
        original_price: service.price,
        price_per_thousand: updatedPricePerThousand,
        packages: updatedPackages,
        applied_discount: {
          discount_type: discount.discount_type,
          discount_value: discount.discount_value,
          description: discount.description
        }
      };
    });
  } catch (err) {
    console.error('Error applying customer discounts:', err);
    return formattedServices;
  }
};

// Get all services or filter by category (Public)
router.get('/', async (req, res) => {
  const { category_id } = req.query;

  try {
    let services = [];
    if (category_id) {
      // First, get the target category to check for linked_categories
      const cat = await getQuery('SELECT linked_categories FROM categories WHERE id = ?', [category_id]);
      let linkedIds = [];
      if (cat && cat.linked_categories) {
        const parsed = safeParseJson(cat.linked_categories);
        if (Array.isArray(parsed)) {
          linkedIds = parsed.map(id => Number(id)).filter(id => !isNaN(id));
        }
      }
      const allCatIds = [Number(category_id), ...linkedIds];
      const placeholders = allCatIds.map(() => '?').join(',');

      services = (await allQuery(`
        SELECT s.*, c.currency as category_currency, c.fields as category_fields, c.fields_title as category_fields_title 
        FROM services s 
        LEFT JOIN categories c ON s.category_id = c.id 
        WHERE s.category_id IN (${placeholders}) 
        ORDER BY s.id ASC
      `, allCatIds)) || [];
    } else {
      services = (await allQuery(`
        SELECT s.*, c.currency as category_currency, c.fields as category_fields, c.fields_title as category_fields_title 
        FROM services s 
        LEFT JOIN categories c ON s.category_id = c.id 
        ORDER BY s.id ASC
      `)) || [];
    }

    const isAdmin = await checkIsAdmin(req);
    let globalMarkup = 0;
    if (!isAdmin) {
      const markupRow = await getQuery("SELECT value FROM settings WHERE key = 'global_markup_percent'");
      globalMarkup = markupRow ? parseFloat(markupRow.value) || 0 : 0;
    }

    // Parse packages JSON string to JS array and apply markup if non-admin
    let formattedServices = services.map(service => {
      let price = parseFloat(service.price) || 0;
      let pricePerThousand = parseFloat(service.price_per_thousand) || 0;
      let servicePackages = safeParseJson(service.packages);

      if (globalMarkup !== 0) {
        price = parseFloat((price * (1 + globalMarkup / 100)).toFixed(2));
        pricePerThousand = parseFloat((pricePerThousand * (1 + globalMarkup / 100)).toFixed(2));
        servicePackages = servicePackages.map(pkg => ({
          ...pkg,
          price: parseFloat(((pkg.price ?? 0) * (1 + globalMarkup / 100)).toFixed(2)),
          usd_price: (pkg.usd_price != null) ? parseFloat((pkg.usd_price * (1 + globalMarkup / 100)).toFixed(2)) : pkg.usd_price
        }));
      }

      return {
        ...service,
        name: (service.name || '').trim(),
        price,
        price_per_thousand: pricePerThousand,
        packages: servicePackages,
        fields: safeParseJson(service.fields),
        category_fields: safeParseJson(service.category_fields)
      };
    });

    // Apply customer-specific discounts if logged in
    const customerId = getCustomerIdFromRequest(req);
    if (customerId) {
      formattedServices = await applyCustomerDiscounts(customerId, formattedServices);
    }

    formattedServices.sort((a, b) => a.name.localeCompare(b.name, 'en'));

    res.json(formattedServices);
  } catch (error) {
    console.error('Fetch services error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الخدمات.' });
  }
});

// Get services for menu (Public)
router.get('/menu', async (req, res) => {
  try {
    const services = await allQuery(`
      SELECT s.id, s.name, s.category_id, s.image, s.price, s.is_popular, c.name as category_name
      FROM services s 
      LEFT JOIN categories c ON s.category_id = c.id 
      ORDER BY s.id ASC
    `) || [];
    res.json(services);
  } catch (error) {
    console.error('Fetch menu services error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب خدمات القائمة.' });
  }
});

// Get popular services (Public)
router.get('/popular', async (req, res) => {
  try {
    // Get manual popular services first, then fallback to order count if none
    let services = (await allQuery(`
      SELECT s.*, 
             c.currency as category_currency, 
             c.fields as category_fields, 
             c.fields_title as category_fields_title
      FROM services s 
      LEFT JOIN categories c ON s.category_id = c.id 
      WHERE s.is_popular = true
      LIMIT 4
    `)) || [];

    if (services.length === 0) {
      services = (await allQuery(`
        SELECT s.*, 
               c.currency as category_currency, 
               c.fields as category_fields, 
               c.fields_title as category_fields_title,
               (SELECT COUNT(*) FROM orders o WHERE o.service_id = s.id) as order_count
        FROM services s 
        LEFT JOIN categories c ON s.category_id = c.id 
        ORDER BY order_count DESC 
        LIMIT 4
      `)) || [];
    }

    const isAdmin = await checkIsAdmin(req);
    let globalMarkup = 0;
    if (!isAdmin) {
      const markupRow = await getQuery("SELECT value FROM settings WHERE key = 'global_markup_percent'");
      globalMarkup = markupRow ? parseFloat(markupRow.value) || 0 : 0;
    }

    let formattedServices = services.map(service => {
      let price = parseFloat(service.price) || 0;
      let pricePerThousand = parseFloat(service.price_per_thousand) || 0;
      let servicePackages = safeParseJson(service.packages);

      if (globalMarkup !== 0) {
        price = parseFloat((price * (1 + globalMarkup / 100)).toFixed(2));
        pricePerThousand = parseFloat((pricePerThousand * (1 + globalMarkup / 100)).toFixed(2));
        servicePackages = servicePackages.map(pkg => ({
          ...pkg,
          price: parseFloat(((pkg.price ?? 0) * (1 + globalMarkup / 100)).toFixed(2)),
          usd_price: (pkg.usd_price != null) ? parseFloat((pkg.usd_price * (1 + globalMarkup / 100)).toFixed(2)) : pkg.usd_price
        }));
      }

      return {
        ...service,
        name: (service.name || '').trim(),
        price,
        price_per_thousand: pricePerThousand,
        packages: servicePackages,
        fields: safeParseJson(service.fields),
        category_fields: safeParseJson(service.category_fields)
      };
    });

    const customerId = getCustomerIdFromRequest(req);
    if (customerId) {
      formattedServices = await applyCustomerDiscounts(customerId, formattedServices);
    }

    res.json(formattedServices);
  } catch (error) {
    console.error('Fetch popular services error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الخدمات الأشهر.' });
  }
});

// Get single service details (Public)
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const service = await getQuery(`
      SELECT s.*, c.currency as category_currency, c.fields as category_fields, c.fields_title as category_fields_title 
      FROM services s 
      LEFT JOIN categories c ON s.category_id = c.id 
      WHERE s.id = ?
    `, [id]);
    
    if (!service) {
      return res.status(404).json({ message: 'الخدمة غير موجودة.' });
    }

    const isAdmin = await checkIsAdmin(req);
    let globalMarkup = 0;
    if (!isAdmin) {
      const markupRow = await getQuery("SELECT value FROM settings WHERE key = 'global_markup_percent'");
      globalMarkup = markupRow ? parseFloat(markupRow.value) || 0 : 0;
    }

    let price = parseFloat(service.price) || 0;
    let pricePerThousand = parseFloat(service.price_per_thousand) || 0;
    let servicePackages = safeParseJson(service.packages);

    if (globalMarkup !== 0) {
      price = parseFloat((price * (1 + globalMarkup / 100)).toFixed(2));
      pricePerThousand = parseFloat((pricePerThousand * (1 + globalMarkup / 100)).toFixed(2));
      servicePackages = servicePackages.map(pkg => ({
        ...pkg,
        price: parseFloat(((pkg.price ?? 0) * (1 + globalMarkup / 100)).toFixed(2)),
        usd_price: (pkg.usd_price != null) ? parseFloat((pkg.usd_price * (1 + globalMarkup / 100)).toFixed(2)) : pkg.usd_price
      }));
    }

    let bundleServicesData = [];
    if (service.is_bundle) {
      let bIds = safeParseJson(service.bundle_services);
      if (Array.isArray(bIds) && bIds.length > 0) {
        const placeholders = bIds.map(() => '?').join(',');
        const bRows = await allQuery(`
          SELECT s.*, c.currency as category_currency, c.fields as category_fields, c.fields_title as category_fields_title
          FROM services s
          LEFT JOIN categories c ON s.category_id = c.id
          WHERE s.id IN (${placeholders})
        `, bIds) || [];
        
        bundleServicesData = bRows.map(bs => {
          let bPrice = parseFloat(bs.price) || 0;
          let bPricePerThousand = parseFloat(bs.price_per_thousand) || 0;
          let bPackages = safeParseJson(bs.packages);
          
          if (globalMarkup !== 0) {
            bPrice = parseFloat((bPrice * (1 + globalMarkup / 100)).toFixed(2));
            bPricePerThousand = parseFloat((bPricePerThousand * (1 + globalMarkup / 100)).toFixed(2));
            bPackages = bPackages.map(pkg => ({
              ...pkg,
              price: parseFloat(((pkg.price ?? 0) * (1 + globalMarkup / 100)).toFixed(2)),
              usd_price: (pkg.usd_price != null) ? parseFloat((pkg.usd_price * (1 + globalMarkup / 100)).toFixed(2)) : pkg.usd_price
            }));
          }
          return {
            ...bs,
            price: bPrice,
            price_per_thousand: bPricePerThousand,
            packages: bPackages,
            fields: safeParseJson(bs.fields),
            category_fields: safeParseJson(bs.category_fields)
          };
        });
      }
    }

    let formattedServiceArray = [{
      ...service,
      price,
      price_per_thousand: pricePerThousand,
      packages: servicePackages,
      fields: safeParseJson(service.fields),
      category_fields: safeParseJson(service.category_fields),
      bundle_services_data: bundleServicesData
    }];

    // Apply customer-specific discounts if logged in
    const customerId = getCustomerIdFromRequest(req);
    if (customerId) {
      formattedServiceArray = await applyCustomerDiscounts(customerId, formattedServiceArray);
    }

    res.json(formattedServiceArray[0]);
  } catch (error) {
    console.error('Fetch service detail error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب تفاصيل الخدمة.' });
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

// Add new service (Admin Protected)
router.post('/', authMiddleware, async (req, res) => {
  const { category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, download_link, download_link_title, is_popular, show_in_menu, is_bundle, bundle_services, api_provider_id, is_featured } = req.body;

  if (!category_id || !name || !name.trim()) {
    return res.status(400).json({ message: 'حقول معرف القسم واسم الخدمة مطلوبة.' });
  }
  const finalName = name.trim();

  try {
    const savedImagePath = await saveImage(image);
    const finalImage = savedImagePath || 'default';
    const packagesStr = typeof packages === 'string' ? packages : JSON.stringify(packages || []);
    const bundleServicesStr = typeof bundle_services === 'string' ? bundle_services : JSON.stringify(bundle_services || []);
    
    const parsedFields = safeParseJson(fields);
    const cleanedFields = removeDuplicateFields(parsedFields);
    const fieldsStr = JSON.stringify(cleanedFields);
    
    const popularFlag = is_popular === true || is_popular === 'true';
    const menuFlag = show_in_menu === true || show_in_menu === 'true';
    const bundleFlag = is_bundle === true || is_bundle === 'true';
    const featuredFlag = is_featured === true || is_featured === 'true';

    const result = await runQuery(
      'INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, download_link, download_link_title, is_popular, show_in_menu, is_bundle, bundle_services, api_provider_id, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [category_id, finalName, description || '', price || 0.0, finalImage, packagesStr, fieldsStr, price_type || 'fixed', price_per_thousand || 0.0, fields_title || '', download_link || '', download_link_title || '', popularFlag, menuFlag, bundleFlag, bundleServicesStr, api_provider_id || null, featuredFlag]
    );

    res.status(201).json({
      message: 'تم إضافة الخدمة بنجاح.',
      id: result.lastID,
      category_id,
      name,
      description,
      price,
      image: finalImage,
      packages: safeParseJson(packagesStr),
      fields: safeParseJson(fieldsStr),
      price_type: price_type || 'fixed',
      price_per_thousand: price_per_thousand || 0.0,
      fields_title: fields_title || '',
      download_link: download_link || '',
      download_link_title: download_link_title || '',
      is_popular: popularFlag,
      show_in_menu: menuFlag,
      is_bundle: bundleFlag,
      bundle_services: safeParseJson(bundleServicesStr),
      is_featured: featuredFlag
    });
  } catch (error) {
    console.error('Add service error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة الخدمة.' });
  }
});

// Update only service fields (Admin Protected) - lightweight endpoint
router.patch('/:id/fields', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { fields, fields_title } = req.body;

  try {
    const parsedFields = safeParseJson(fields);
    const cleanedFields = removeDuplicateFields(parsedFields);
    const fieldsStr = JSON.stringify(cleanedFields);
    const finalTitle = (fields_title && fields_title.trim()) ? fields_title.trim() : 'بيانات الخدمة';

    await runQuery(
      'UPDATE services SET fields = ?, fields_title = ? WHERE id = ?',
      [fieldsStr, finalTitle, id]
    );

    res.json({
      message: 'تم تحديث حقول الخدمة بنجاح.',
      id,
      fields: cleanedFields,
      fields_title: finalTitle
    });
  } catch (error) {
    console.error('Update service fields error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث حقول الخدمة.' });
  }
});

// Bulk update fields for all services in a category (Admin Protected)
router.patch('/bulk/fields-by-category', authMiddleware, async (req, res) => {
  const { category_id, fields, fields_title } = req.body;
  if (!category_id) return res.status(400).json({ message: 'category_id مطلوب.' });

  try {
    const parsedFields = safeParseJson(fields);
    const cleanedFields = removeDuplicateFields(parsedFields);
    const fieldsStr = JSON.stringify(cleanedFields);
    const finalTitle = (fields_title && fields_title.trim()) ? fields_title.trim() : 'بيانات الخدمة';

    const { getDatabaseMode } = require('../db');
    if (false && getDatabaseMode && getDatabaseMode().fallbackMode) {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '../database.json');
      if (fs.existsSync(dbPath)) {
        const { readDb, writeDb } = require('../db');
            const db = readDb();
        let count = 0;
        db.services = (db.services || []).map(s => {
          if (Number(s.category_id) === Number(category_id)) {
            count++;
            return { ...s, fields: cleanedFields, fields_title: finalTitle };
          }
          return s;
        });
        writeDb(db);
        return res.json({ message: `تم تحديث ${count} خدمة بنجاح.`, count, fields: cleanedFields });
      }
    } else {
      const result = await runQuery(
        'UPDATE services SET fields = ?, fields_title = ? WHERE category_id = ?',
        [fieldsStr, finalTitle, category_id]
      );
      return res.json({ message: 'تم التحديث بنجاح.', fields: cleanedFields });
    }
  } catch (error) {
    console.error('Bulk update fields error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء التحديث الجماعي.' });
  }
});

// Update service (Admin Protected)
router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, download_link, download_link_title, is_popular, show_in_menu, is_bundle, bundle_services, api_provider_id, is_featured } = req.body;

  if (!category_id || !name || !name.trim()) {
    return res.status(400).json({ message: 'حقول معرف القسم واسم الخدمة مطلوبة للتحديث.' });
  }
  const finalName = name.trim();

  try {
    const finalImage = await saveImage(image);
    const packagesStr = typeof packages === 'string' ? packages : JSON.stringify(packages || []);
    const bundleServicesStr = typeof bundle_services === 'string' ? bundle_services : JSON.stringify(bundle_services || []);
    
    const parsedFields = safeParseJson(fields);
    const cleanedFields = removeDuplicateFields(parsedFields);
    const fieldsStr = JSON.stringify(cleanedFields);

    const popularFlag = is_popular === true || is_popular === 'true';
    const menuFlag = show_in_menu === true || show_in_menu === 'true';
    const bundleFlag = is_bundle === true || is_bundle === 'true';
    const featuredFlag = is_featured === true || is_featured === 'true';

    await runQuery(
      'UPDATE services SET category_id = ?, name = ?, description = ?, price = ?, image = ?, packages = ?, fields = ?, price_type = ?, price_per_thousand = ?, fields_title = ?, download_link = ?, download_link_title = ?, is_popular = ?, show_in_menu = ?, is_bundle = ?, bundle_services = ?, api_provider_id = ?, is_featured = ? WHERE id = ?',
      [category_id, finalName, description, price, finalImage, packagesStr, fieldsStr, price_type || 'fixed', price_per_thousand || 0.0, fields_title || '', download_link || '', download_link_title || '', popularFlag, menuFlag, bundleFlag, bundleServicesStr, api_provider_id || null, featuredFlag, id]
    );

    res.json({
      message: 'تم تحديث الخدمة بنجاح.',
      id,
      category_id,
      name,
      description,
      price,
      image: finalImage,
      packages: safeParseJson(packagesStr),
      fields: safeParseJson(fieldsStr),
      price_type: price_type || 'fixed',
      price_per_thousand: price_per_thousand || 0.0,
      fields_title: fields_title || '',
      download_link: download_link || '',
      download_link_title: download_link_title || '',
      is_popular: popularFlag,
      show_in_menu: menuFlag,
      is_featured: featuredFlag
    });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث الخدمة.' });
  }
});

// Delete all services (Admin Protected)
router.delete('/all/clear', authMiddleware, deleteOtpAuth, async (req, res) => {
  try {
    await runQuery('DELETE FROM services');
    
    const { getDatabaseMode } = require('../db');
    if (getDatabaseMode && getDatabaseMode().fallbackMode) {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '../database.json');
      if (fs.existsSync(dbPath)) {
        try {
          const { readDb, writeDb } = require('../db');
            const db = readDb();
          db.services = [];
          writeDb(db);
        } catch (err) {
          console.error('JSON bulk delete services error:', err);
        }
      }
    }

    res.json({ message: 'تم حذف جميع الخدمات بنجاح.' });
  } catch (error) {
    console.error('Delete all services error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف جميع الخدمات.' });
  }
});

// Delete service (Admin Protected)
router.delete('/:id', authMiddleware, deleteOtpAuth, async (req, res) => {
  const { id } = req.params;

  try {
    await runQuery('DELETE FROM services WHERE id = ?', [id]);
    res.json({ message: 'تم حذف الخدمة بنجاح.', id });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف الخدمة.' });
  }
});

// Toggle popular status (Admin Protected)
router.patch('/:id/popular', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { is_popular } = req.body;
  try {
    const popularFlag = is_popular === true || is_popular === 'true';
    
    const { getDatabaseMode } = require('../db');
    if (getDatabaseMode && getDatabaseMode().fallbackMode) {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(__dirname, '../database.json');
      if (fs.existsSync(dbPath)) {
        const { readDb, writeDb } = require('../db');
            const db = readDb();
        db.services = (db.services || []).map(s => {
          if (Number(s.id) === Number(id)) {
            return { ...s, is_popular: popularFlag };
          }
          return s;
        });
        writeDb(db);
      }
    } else {
      await runQuery('UPDATE services SET is_popular = ? WHERE id = ?', [popularFlag, id]);
    }
    
    res.json({ message: 'تم تحديث حالة الخدمة بنجاح.', id, is_popular: popularFlag });
  } catch (error) {
    console.error('Toggle popular error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء التحديث.' });
  }
});

module.exports = router;
