const express = require('express');
const router = express.Router();
const https = require('https');
const { runQuery, allQuery, getQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const wa = require('../whatsapp');

// In-memory lock to prevent concurrent auto-submit calls for the same order.
// Without this, two simultaneous requests can both pass the api_status check
// before either one writes the error back, causing duplicate provider calls.
const submittingOrders = new Set();

const { callDhruApi, stripHtml, getDhruErrorMessage, extractCustomFields, normalizeCustomField, parseDhruServices, buildStoredCustomField } = require('../services/dhruClient');
const { placeDynamicOrder } = require('../services/dynamicClient');

// 1. Get Settings (Admin Protected or Public fallback)
router.get('/settings', async (req, res) => {
  try {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    
    let apiKey = apiKeyRow ? apiKeyRow.value : '';
    let apiUrl = apiUrlRow ? apiUrlRow.value : '';
    let apiUser = apiUserRow ? apiUserRow.value : '';
    
    if (apiUser === null || apiUser === undefined) {
      apiUser = '';
      const exists = await getQuery("SELECT * FROM settings WHERE key = 'amrr_unlocker_username'");
      if (!exists) {
        await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_unlocker_username', '')");
      }
    }
    
    // Seed defaults if empty
    apiKey = 'QNR-UP9-IU5-5BZ-1T-ZQZ-1DT-RIH';
    const exists = await getQuery("SELECT * FROM settings WHERE key = 'amrr_unlocker_api_key'");
    if (!exists) {
      await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_unlocker_api_key', ?)", [apiKey]);
    } else {
      await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_unlocker_api_key'", [apiKey]);
    }
    if (!apiUrl) {
      apiUrl = 'https://amrr-unlocker.com/api/index.php';
      const exists = await getQuery("SELECT * FROM settings WHERE key = 'amrr_unlocker_api_url'");
      if (!exists) {
        await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_unlocker_api_url', ?)", [apiUrl]);
      } else {
        await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_unlocker_api_url'", [apiUrl]);
      }
    }
    
    res.json({
      api_key: apiKey,
      api_url: apiUrl,
      username: apiUser
    });
  } catch (error) {
    console.error('Fetch unlocker settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب إعدادات البوابة.' });
  }
});

// Debug route to see exact raw fields from Dhru
router.get('/debug-service/:id', async (req, res) => {
  try {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    const apiKey = apiKeyRow && apiKeyRow.value ? apiKeyRow.value : '5TC-O62-NRZ-HF3-NQ4-3VJ-S7V-FPK';
    const apiUrl = apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrr-unlocker.com/api/index.php';
    const apiUser = apiUserRow && apiUserRow.value ? apiUserRow.value : 'Hassen1990';

    const data = await callDhruApi(apiUrl, apiUser, apiKey, 'imeiservicelist');
    let targetService = null;

    if (data.SUCCESS === true && Array.isArray(data.RESULT)) {
      for (const group of data.RESULT) {
        if (Array.isArray(group.SERVICES)) {
          const found = group.SERVICES.find(s => s.SERVICEID == req.params.id);
          if (found) targetService = found;
        }
      }
    } else if (Array.isArray(data.SUCCESS)) {
      const first = data.SUCCESS[0];
      if (first && first.LIST && typeof first.LIST === 'object') {
        for (const catKey of Object.keys(first.LIST)) {
          const catObj = first.LIST[catKey];
          if (Array.isArray(catObj)) {
            const found = catObj.find(s => s.SERVICEID == req.params.id);
            if (found) targetService = found;
          } else if (catObj && typeof catObj === 'object' && catObj.SERVICES) {
            for (const key of Object.keys(catObj.SERVICES)) {
              const svc = catObj.SERVICES[key];
              if (svc.SERVICEID == req.params.id) targetService = svc;
            }
          }
        }
      }
    }

    if (targetService) {
      res.json({
        raw_service: targetService,
        extracted_fields: extractCustomFields(targetService)
      });
    } else {
      res.status(404).json({ message: 'Service not found in API' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug route: show ALL services and their raw custom fields from Omar server API
// Usage: GET /api/unlocker/debug-all-fields?type=imei   (type = imei | server | remote)
// Returns up to 50 services with their raw data + extracted fields so you can compare
router.get('/debug-all-fields', async (req, res) => {
  try {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    const apiKey = apiKeyRow && apiKeyRow.value ? apiKeyRow.value : '5TC-O62-NRZ-HF3-NQ4-3VJ-S7V-FPK';
    const apiUrl = apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrr-unlocker.com/api/index.php';
    const apiUser = apiUserRow && apiUserRow.value ? apiUserRow.value : 'Hassen1990';

    const serviceType = req.query.type || 'imei'; // imei | server | remote
    const action = serviceType === 'server' ? 'serverservicelist' : (serviceType === 'remote' ? 'remoteservicelist' : 'imeiservicelist');
    const limit = parseInt(req.query.limit) || 50; // how many services to return

    const data = await callDhruApi(apiUrl, apiUser, apiKey, action);

    // Collect all raw services
    const rawServices = [];

    if (data.SUCCESS === true && Array.isArray(data.RESULT)) {
      // Format C
      for (const group of data.RESULT) {
        const groupName = group.GROUPNAME || 'عام';
        if (Array.isArray(group.SERVICES)) {
          for (const s of group.SERVICES) {
            rawServices.push({ _group: groupName, ...s });
          }
        }
      }
    } else if (Array.isArray(data.SUCCESS)) {
      const first = data.SUCCESS[0];
      if (first && first.LIST && typeof first.LIST === 'object') {
        for (const catKey of Object.keys(first.LIST)) {
          const catObj = first.LIST[catKey];
          if (Array.isArray(catObj)) {
            for (const s of catObj) rawServices.push({ _group: catKey, ...s });
          } else if (catObj && typeof catObj === 'object') {
            const groupName = catObj.GROUPNAME || catKey;
            const servicesObj = catObj.SERVICES;
            if (Array.isArray(servicesObj)) {
              for (const s of servicesObj) rawServices.push({ _group: groupName, ...s });
            } else if (servicesObj && typeof servicesObj === 'object') {
              for (const svcKey of Object.keys(servicesObj)) {
                const s = servicesObj[svcKey];
                if (s && s.SERVICEID) rawServices.push({ _group: groupName, ...s });
              }
            }
          }
        }
      } else {
        for (const s of data.SUCCESS) {
          if (s.SERVICEID) rawServices.push({ _group: s.GROUPNAME || 'عام', ...s });
        }
      }
    }

    if (rawServices.length === 0) {
      return res.json({
        success: false,
        message: 'لم يُعثر على أي خدمات. تحقق من الـ API key والـ URL.',
        raw_response_keys: Object.keys(data),
        raw_sample: JSON.stringify(data).substring(0, 500)
      });
    }

    // Build a diagnostic report for each service (up to limit)
    const sample = rawServices.slice(0, limit);
    const report = sample.map(s => {
      const extracted = extractCustomFields(s);
      const normalized = extracted.map(normalizeCustomField).filter(Boolean);
      return {
        id: s.SERVICEID,
        name: s.SERVICENAME,
        group: s._group,
        price: s.PRICE || s.CREDIT || 0,
        has_custom_fields: normalized.length > 0,
        custom_fields_count: normalized.length,
        custom_fields: normalized,
        // Show WHICH raw keys contained field data (diagnostic)
        raw_field_keys: Object.keys(s).filter(k =>
          k.toLowerCase().includes('custom') ||
          k.toLowerCase().includes('field') ||
          k.toLowerCase().includes('require') ||
          k === 'FIELDS' || k === 'Fields'
        ),
        // Show the raw REQUIRES structure if present
        raw_requires: s.REQUIRES || s.Requires || s['REQUIRES'] || null
      };
    });

    // Summary stats
    const withFields = report.filter(r => r.has_custom_fields);
    const withoutFields = report.filter(r => !r.has_custom_fields);

    res.json({
      success: true,
      service_type: serviceType,
      api_url: apiUrl,
      total_services_from_api: rawServices.length,
      showing: sample.length,
      summary: {
        with_custom_fields: withFields.length,
        without_custom_fields: withoutFields.length,
        services_with_fields: withFields.map(r => ({ id: r.id, name: r.name, fields: r.custom_fields.map(f => f.fieldname) }))
      },
      services: report
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Update Settings (Admin Protected)
router.put('/settings', authMiddleware, async (req, res) => {
  const { api_key, api_url, username } = req.body;
  if (!api_key || !api_url || username === undefined) {
    return res.status(400).json({ message: 'جميع الحقول مطلوبة.' });
  }
  
  try {
    await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_unlocker_api_key'", [api_key.trim()]);
    await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_unlocker_api_url'", [api_url.trim()]);
    
    const exists = await getQuery("SELECT * FROM settings WHERE key = 'amrr_unlocker_username'");
    if (!exists) {
      await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_unlocker_username', ?)", [username.trim()]);
    } else {
      await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_unlocker_username'", [username.trim()]);
    }
    res.json({ message: 'تم تحديث الإعدادات بنجاح.' });
  } catch (error) {
    console.error('Update unlocker settings error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث إعدادات البوابة.' });
  }
});

// 3. Fetch Services from Remote API (Admin Protected)
router.post('/fetch-services', authMiddleware, async (req, res) => {
  try {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    const apiKey = apiKeyRow && apiKeyRow.value ? apiKeyRow.value : 'QNR-UP9-IU5-5BZ-1T-ZQZ-1DT-RIH';
    const apiUrl = apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrr-unlocker.com/api/index.php';
    const apiUser = apiUserRow && apiUserRow.value ? apiUserRow.value : 'Hassen1990';
    
    // Fetch all service types (IMEI, Server, and Remote) to guarantee complete service coverage
    const [imeiRes, serverRes, remoteRes] = await Promise.all([
      callDhruApi(apiUrl, apiUser, apiKey, 'imeiservicelist').catch(e => ({ ERROR: e.message })),
      callDhruApi(apiUrl, apiUser, apiKey, 'serverservicelist').catch(e => ({ ERROR: e.message })),
      callDhruApi(apiUrl, apiUser, apiKey, 'remoteservicelist').catch(e => ({ ERROR: e.message }))
    ]);
    
    const services = [
      ...parseDhruServices(imeiRes, 'imei'),
      ...parseDhruServices(serverRes, 'server'),
      ...parseDhruServices(remoteRes, 'remote')
    ];
    
    if (services.length === 0) {
      if (imeiRes.ERROR && !serverRes.SUCCESS && !remoteRes.SUCCESS) {
        console.error('[Dhru API Error Response]:', JSON.stringify(imeiRes.ERROR));
        const errObj = Array.isArray(imeiRes.ERROR) ? imeiRes.ERROR[0] : imeiRes.ERROR;
        const errorMsg = errObj.MESSAGE || errObj.message || JSON.stringify(errObj);
        return res.status(400).json({ message: `خطأ من الخادم: ${errorMsg}` });
      }
      return res.status(400).json({ message: 'لم يتم العثور على أي خدمات. يرجى مراجعة صلاحيات المفتاح مع مزود الخدمة.' });
    }
    
    res.json({
      success: true,
      servicesCount: services.length,
      services: services
    });
  } catch (error) {
    console.error('Fetch unlocker services error:', error.message);
    res.status(500).json({ message: error.message || 'فشل الاتصال بالخادم الخارجي. قد يكون جدار الحماية (Cloudflare) يمنع هذا الطلب.' });
  }
});

// 3b. Fetch supplier account info and balance (Admin Protected)
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    
    const apiKey = apiKeyRow && apiKeyRow.value ? apiKeyRow.value : 'QNR-UP9-IU5-5BZ-1T-ZQZ-1DT-RIH';
    const apiUrl = apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrr-unlocker.com/api/index.php';
    const apiUser = apiUserRow && apiUserRow.value ? apiUserRow.value : 'Hassen1990';
    
    let responseData;
    try {
      responseData = await callDhruApi(apiUrl, apiUser, apiKey, 'accountinfo');
    } catch (err) {
      if (process.env.USE_LOCAL_JSON_DB === 'true' || err.message.includes('403') || err.message.includes('Cloudflare')) {
        console.warn('Unlocker API unreachable or Cloudflare 403 blocked. Returning offline local balance simulation.');
        return res.json({
          success: true,
          credit: "$0.00 (محلي/حظر Cloudflare مؤقت)",
          credit_raw: 0,
          currency: "USD",
          email: "local-mode@offline"
        });
      }
      throw err;
    }
    
    if (responseData.ERROR) {
      const errorMsg = getDhruErrorMessage(responseData);
      return res.status(400).json({ message: `فشل جلب رصيد الحساب: ${errorMsg}` });
    }
    
    let info = null;
    if (responseData.SUCCESS && Array.isArray(responseData.SUCCESS)) {
      info = responseData.SUCCESS[0]?.AccountInfo || null;
    }
    
    if (!info) {
      return res.status(400).json({ message: 'تعذر الحصول على معلومات الحساب.' });
    }
    
    res.json({
      success: true,
      credit: info.credit ? info.credit.trim() : `$${info.creditraw}`,
      credit_raw: parseFloat(info.creditraw) || 0,
      currency: info.currency || 'USD',
      email: info.mail || ''
    });
  } catch (error) {
    console.error('Fetch balance error:', error.message);
    if (process.env.USE_LOCAL_JSON_DB === 'true') {
      return res.json({
        success: true,
        credit: "$0.00 (محلي/غير متصل)",
        credit_raw: 0,
        currency: "USD",
        email: "local-mode@offline"
      });
    }
    res.status(500).json({ message: error.message || 'حدث خطأ أثناء جلب معلومات الرصيد.' });
  }
});

// Core Smart Sync Logic
async function performSmartSync(customRate, customMarkup, customShouldGroup) {
  // 1. Determine settings
  const rateRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_exchange_rate'");
  const markupRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_markup_percent'");
  const groupRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_group_as_packages'");
  
  const rate = customRate !== undefined ? parseFloat(customRate) : (rateRow ? parseFloat(rateRow.value) : 50);
  const markup = customMarkup !== undefined ? parseFloat(customMarkup) : (markupRow ? parseFloat(markupRow.value) : 10);
  const shouldGroup = customShouldGroup !== undefined ? customShouldGroup : (groupRow ? groupRow.value === 'true' : true);

  const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
  const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
  const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
  const apiKey = apiKeyRow && apiKeyRow.value ? apiKeyRow.value : '5TC-O62-NRZ-HF3-NQ4-3VJ-S7V-FPK';
  const apiUrl = apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrr-unlocker.com/api/index.php';
  const apiUser = apiUserRow && apiUserRow.value ? apiUserRow.value : 'Hassen1990';

  console.log('[Smart Sync] Fetching fresh services list from provider...');
  const [imeiRes, serverRes, remoteRes] = await Promise.all([
    callDhruApi(apiUrl, apiUser, apiKey, 'imeiservicelist').catch(e => ({ ERROR: e.message })),
    callDhruApi(apiUrl, apiUser, apiKey, 'serverservicelist').catch(e => ({ ERROR: e.message })),
    callDhruApi(apiUrl, apiUser, apiKey, 'remoteservicelist').catch(e => ({ ERROR: e.message }))
  ]);

  const allServices = [
    ...parseDhruServices(imeiRes, 'imei'),
    ...parseDhruServices(serverRes, 'server'),
    ...parseDhruServices(remoteRes, 'remote')
  ];

  if (allServices.length === 0) {
    throw new Error('تعذر جلب الخدمات من المزود، تأكد من الاتصال أو المفاتيح.');
  }

  let apiCurrency = 'USD';
  try {
    const balanceData = await callDhruApi(apiUrl, apiUser, apiKey, 'accountinfo');
    if (balanceData && balanceData.SUCCESS && Array.isArray(balanceData.SUCCESS)) {
      apiCurrency = balanceData.SUCCESS[0]?.AccountInfo?.currency || 'USD';
    }
  } catch (e) {
    console.warn('Failed to fetch provider currency, defaulting to USD');
  }

  console.log(`[Smart Sync] Processing ${allServices.length} services using UPSERT...`);

  let addedCategoriesCount = 0;
  let addedServicesCount = 0;
  let updatedServicesCount = 0;

  if (shouldGroup) {
    const groups = {};
    for (const s of allServices) {
      const catName = s.category || 'عام';
      if (!groups[catName]) groups[catName] = [];
      groups[catName].push(s);
    }

    for (const [groupName, groupServices] of Object.entries(groups)) {
      const cleanGroupName = groupName || 'عام';

      const combinedFields = [];
      const addedFieldNames = new Set();
      
      for (const s of groupServices) {
        if (s.customFields && Array.isArray(s.customFields)) {
          for (const cf of s.customFields) {
            const storedField = buildStoredCustomField(cf);
            if (!storedField) continue;
            const fieldLabel = String(storedField.api_name || '').toLowerCase().trim();
            if (!addedFieldNames.has(storedField.id) && !addedFieldNames.has(fieldLabel)) {
              addedFieldNames.add(storedField.id);
              addedFieldNames.add(fieldLabel);
              combinedFields.push(storedField);
            }
          }
        }
      }

      // UPSERT CATEGORY
      let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [cleanGroupName]);
      let categoryId;
      if (!cat) {
        const catInsert = await runQuery(
          "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false)",
          [cleanGroupName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify(combinedFields), 'بيانات الخدمة']
        );
        categoryId = catInsert.lastID;
        addedCategoriesCount++;
      } else {
        categoryId = cat.id;
        // Optionally update category fields here if needed
        await runQuery("UPDATE categories SET fields = ? WHERE id = ?", [JSON.stringify(combinedFields), categoryId]);
      }

      const mergedPackages = [];
      let multiplier = 1;
      if (apiCurrency === 'EGP') {
        multiplier = 1 / rate;
      }

      groupServices.forEach((s, idx) => {
        const apiPriceUsd = parseFloat(s.price) || 0;
        const localPrice = parseFloat((apiPriceUsd * multiplier * (1 + markup / 100)).toFixed(2));
        const cleanPkgName = s.name || 'تفعيل فوري تلقائي';

        const isDynamicPkg = (s.max_quantity > 1 && s.max_quantity !== s.min_quantity) || (s.min_quantity > 1 && s.max_quantity === 0) || s.requires_quantity;

        const packageFields = [];
        const hasCustom = s.customFields && s.customFields.length > 0;
        
        // Removed fallback player_id injection for packages
        if (hasCustom) {
          s.customFields.forEach(cf => {
            const storedField = buildStoredCustomField(cf);
            if (storedField) packageFields.push(storedField);
          });
        }

        mergedPackages.push({
          id: idx + 1,
          name: cleanPkgName,
          price: localPrice,
          usd_price: localPrice,
          api_service_id: s.id.toString(),
          // Store service type per-package so order submission uses correct API action
          api_service_type: s.serviceType || 'imei',
          status: "Available",
          discount: 0,
          min_quantity: s.min_quantity || 1,
          max_quantity: s.max_quantity || 0,
          requires_quantity: isDynamicPkg,
          fields: packageFields
        });
      });

      const minPrice = mergedPackages.length > 0 ? Math.min(...mergedPackages.map(p => p.price)) : 0;
      const packagesJson = JSON.stringify(mergedPackages);
      const fieldsJson = JSON.stringify(combinedFields);

      // Determine dominant service type for the group (most common)
      const typeCounts = groupServices.reduce((acc, s) => { const t = s.serviceType || 'imei'; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
      const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'imei';

      // UPSERT SERVICE (Grouped by name since api_service_id is 'grouped')
      let existingSvc = await getQuery("SELECT id FROM services WHERE name = ? AND api_source = 'amrr-unlocker' AND api_service_id = 'grouped'", [cleanGroupName]);
      
      if (!existingSvc) {
        await runQuery(
          "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_price, min_quantity, max_quantity, api_service_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [categoryId, cleanGroupName, `باقات وتفعيل خدمات ${cleanGroupName}`, minPrice, 'default', packagesJson, fieldsJson, 'fixed', 0, 'بيانات الخدمة', 'grouped', 'amrr-unlocker', 0, 1, 0, dominantType]
        );
        addedServicesCount++;
      } else {
        await runQuery(
          "UPDATE services SET price = ?, packages = ?, fields = ?, category_id = ?, api_service_type = ?, api_delivery_time = ? WHERE id = ?",
          [minPrice, packagesJson, fieldsJson, categoryId, dominantType, '', existingSvc.id]
        );
        updatedServicesCount++;
      }
    }
  } else {
    // Individual Services UPSERT
    for (const s of allServices) {
      const cleanCategoryName = s.category || 'عام';

      let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [cleanCategoryName]);
      let categoryId;
      if (!cat) {
        const defaultFields = [];
        const catInsert = await runQuery(
          "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false)",
          [cleanCategoryName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify(defaultFields), 'بيانات الخدمة']
        );
        categoryId = catInsert.lastID;
        addedCategoriesCount++;
      } else {
        categoryId = cat.id;
      }

      const serviceFields = [];
      if (s.customFields && Array.isArray(s.customFields)) {
        s.customFields.forEach(cf => {
          const storedField = buildStoredCustomField(cf);
          if (storedField) serviceFields.push(storedField);
        });
      }
      let multiplier = 1;
      if (apiCurrency === 'EGP') multiplier = 1 / rate;

      const apiPriceUsd = parseFloat(s.price) || 0;
      const localPrice = parseFloat((apiPriceUsd * multiplier * (1 + markup / 100)).toFixed(2));
      const cleanServiceName = s.name || 'تفعيل فوري تلقائي';
      const svcType = s.serviceType || 'imei';

      const minQty = s.min_quantity || 1;
      const maxQty = s.max_quantity || 0;
      const isDynamic = (maxQty > 1 && maxQty !== minQty) || (minQty > 1 && maxQty === 0) || s.requires_quantity;
      
      const priceType = isDynamic ? 'dynamic' : 'fixed';
      const pricePerThousand = isDynamic ? localPrice * 1000 : 0;
      
      const packagesJson = isDynamic ? '[]' : JSON.stringify([{ id: 1, name: "تفعيل فوري تلقائي", price: localPrice, usd_price: localPrice, api_service_id: s.id.toString(), api_service_type: svcType, status: "Available", discount: 0, fields: serviceFields }]);
      const fieldsJson = JSON.stringify(serviceFields);

      let existingSvc = await getQuery("SELECT id FROM services WHERE api_service_id = ? AND api_source = 'amrr-unlocker'", [s.id.toString()]);

      if (!existingSvc) {
        await runQuery(
          "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_price, min_quantity, max_quantity, api_service_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [categoryId, cleanServiceName, `تفعيل خدمة ${cleanServiceName} فوري عبر API`, isDynamic ? 0 : localPrice, 'default', packagesJson, fieldsJson, priceType, pricePerThousand, 'بيانات الخدمة', s.id.toString(), 'amrr-unlocker', apiPriceUsd, minQty, maxQty, svcType, s.time || '']
        );
        addedServicesCount++;
      } else {
        await runQuery(
          "UPDATE services SET price = ?, packages = ?, fields = ?, price_type = ?, price_per_thousand = ?, api_price = ?, min_quantity = ?, max_quantity = ?, category_id = ?, name = ?, api_service_type = ?, api_delivery_time = ? WHERE id = ?",
          [isDynamic ? 0 : localPrice, packagesJson, fieldsJson, priceType, pricePerThousand, apiPriceUsd, minQty, maxQty, categoryId, cleanServiceName, svcType, s.time || '', existingSvc.id]
        );
        updatedServicesCount++;
      }
    }
  }

  return { addedCategoriesCount, addedServicesCount, updatedServicesCount };
}

// 3c. Smart Sync All from Amrr Unlocker (Admin Protected)
router.post('/wipe-and-sync-all', authMiddleware, async (req, res) => {
  const { exchange_rate, markup_percent, group_as_packages } = req.body;
  
  // Save settings globally to allow background auto-sync to use them
  if (exchange_rate) {
    const exists = await getQuery("SELECT * FROM settings WHERE key = 'amrr_exchange_rate'");
    if (exists) await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_exchange_rate'", [exchange_rate]);
    else await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_exchange_rate', ?)", [exchange_rate]);
  }
  if (markup_percent) {
    const exists = await getQuery("SELECT * FROM settings WHERE key = 'amrr_markup_percent'");
    if (exists) await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_markup_percent'", [markup_percent]);
    else await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_markup_percent', ?)", [markup_percent]);
  }
  if (group_as_packages !== undefined) {
    const val = group_as_packages ? 'true' : 'false';
    const exists = await getQuery("SELECT * FROM settings WHERE key = 'amrr_group_as_packages'");
    if (exists) await runQuery("UPDATE settings SET value = ? WHERE key = 'amrr_group_as_packages'", [val]);
    else await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_group_as_packages', ?)", [val]);
  }

  try {
    const result = await performSmartSync(exchange_rate, markup_percent, group_as_packages);
    res.json({
      success: true,
      message: `تم تحديث المزامنة بذكاء (بدون حذف). تم إضافة ${result.addedCategoriesCount} قسماً جديداً و ${result.addedServicesCount} خدمة جديدة، وتحديث أسعار ${result.updatedServicesCount} خدمة.`,
      categoriesCount: result.addedCategoriesCount,
      servicesCount: result.addedServicesCount + result.updatedServicesCount
    });
  } catch (error) {
    console.error('Smart sync all error:', error.message);
    res.status(500).json({ message: `حدث خطأ أثناء المزامنة: ${error.message}` });
  }
});

// 4. Import Services (Admin Protected)
router.post('/import-services', authMiddleware, async (req, res) => {
  const { services, exchange_rate, markup_percent, local_category_id, custom_category_name, group_as_packages } = req.body;
  
  if (!Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ message: 'يرجى تحديد خدمة واحدة على الأقل للاستيراد.' });
  }
  
  const rate = parseFloat(exchange_rate) || 1;
  const markup = parseFloat(markup_percent) || 0;
  
  try {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    const apiKey = apiKeyRow && apiKeyRow.value ? apiKeyRow.value : '5TC-O62-NRZ-HF3-NQ4-3VJ-S7V-FPK';
    const apiUrl = apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrr-unlocker.com/api/index.php';
    const apiUser = apiUserRow && apiUserRow.value ? apiUserRow.value : 'Hassen1990';

    let apiCurrency = 'USD';
    try {
      const balanceData = await callDhruApi(apiUrl, apiUser, apiKey, 'accountinfo');
      if (balanceData && balanceData.SUCCESS && Array.isArray(balanceData.SUCCESS)) {
        apiCurrency = balanceData.SUCCESS[0]?.AccountInfo?.currency || 'USD';
      }
    } catch (e) {
      console.warn('Failed to fetch provider currency for import-services, defaulting to USD:', e.message);
    }

    const importedList = [];
    // Check if we should create a new category or use a specific one
    let targetCategoryId = null;
    if (local_category_id === 'new' && custom_category_name && custom_category_name.trim()) {
      const trimmedName = custom_category_name.replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim() || custom_category_name;
      let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [trimmedName]);
      if (!cat) {
        const defaultFields = [];
        const catInsert = await runQuery(
          "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false)",
          [trimmedName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify(defaultFields), 'بيانات الخدمة']
        );
        targetCategoryId = catInsert.lastID;
      } else {
        targetCategoryId = cat.id;
      }
    } else if (local_category_id && local_category_id !== 'auto' && local_category_id !== 'new') {
      targetCategoryId = parseInt(local_category_id);
    }
    
    if (group_as_packages) {
      // Group services by category name
      const groups = {};
      for (const s of services) {
        const catName = (s.category || 'أدوات تخطي آيكلود').replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim() || s.category || 'أدوات تخطي آيكلود';
        if (!groups[catName]) {
          groups[catName] = [];
        }
        groups[catName].push(s);
      }

      for (const [groupName, groupServices] of Object.entries(groups)) {
        await new Promise(r => setImmediate(r));
        const cleanGroupName = groupName.replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim() || groupName || 'أدوات تخطي آيكلود';

        let categoryId = targetCategoryId;
        if (!categoryId) {
          let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [cleanGroupName]);
          if (!cat) {
            const defaultFields = [];
            const catInsert = await runQuery(
              "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false)",
              [cleanGroupName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify(defaultFields), 'بيانات الخدمة']
            );
            categoryId = catInsert.lastID;
          } else {
            categoryId = cat.id;
          }
        }

        const combinedFields = [];
        const addedFieldNames = new Set();

        let hasCustomFields = false;

        for (const s of groupServices) {
          if (s.customFields && s.customFields.length > 0) {
            hasCustomFields = true;
            break;
          }
        }

        let hasGroupCustomFields = groupServices.some(s => s.customFields && s.customFields.length > 0);
        // Removed fallback player_id injection for group services in specific sync

        for (const s of groupServices) {
          if (s.customFields && Array.isArray(s.customFields)) {
            for (const cf of s.customFields) {
              const storedField = buildStoredCustomField(cf);
              if (!storedField) continue;
              const fieldLabel = String(storedField.api_name || '').toLowerCase().trim();
              if (!addedFieldNames.has(storedField.id) && !addedFieldNames.has(fieldLabel)) {
                addedFieldNames.add(storedField.id);
                addedFieldNames.add(fieldLabel);
                combinedFields.push(storedField);
              }
            }
          }
        }

        const existingService = await getQuery(
          "SELECT * FROM services WHERE name = ? AND api_source = 'amrr-unlocker' AND category_id = ?",
          [cleanGroupName, categoryId]
        );

        const categoryRow = await getQuery("SELECT currency FROM categories WHERE id = ?", [categoryId]);
        const categoryCurrency = categoryRow ? categoryRow.currency : 'USD';
        const isUsdCategory = categoryCurrency === 'USD';

        let mergedPackages = [];
        if (existingService) {
          try {
            mergedPackages = typeof existingService.packages === 'string' 
              ? JSON.parse(existingService.packages) 
              : (existingService.packages || []);
          } catch (e) {
            mergedPackages = [];
          }
        }

        // Calculate pricing multiplier based on API account currency vs target category currency
        let multiplier = 1;
        if (apiCurrency === 'USD' && categoryCurrency === 'EGP') {
          multiplier = rate;
        } else if (apiCurrency === 'EGP' && categoryCurrency === 'USD') {
          multiplier = 1 / rate;
        }

        for (const s of groupServices) {
          const apiPriceUsd = parseFloat(s.price) || 0;
          
          let localPrice;
          if (s.custom_price !== undefined && s.custom_price !== null) {
            localPrice = parseFloat(s.custom_price);
          } else {
            if (isUsdCategory) {
              localPrice = parseFloat(((apiPriceUsd * multiplier) * (1 + markup / 100)).toFixed(2));
            } else {
              localPrice = Math.ceil((apiPriceUsd * multiplier) * (1 + markup / 100));
            }
          }

          const discount = s.custom_discount !== undefined && s.custom_discount !== null ? parseFloat(s.custom_discount) : 0;
          const cleanPkgName = s.name.replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim() || 'تفعيل فوري تلقائي';

          const pkgIndex = mergedPackages.findIndex(p => p.api_service_id === s.id.toString());
          const packageFields = [];
          const hasCustom = s.customFields && s.customFields.length > 0;

          if (hasCustom) {
            s.customFields.forEach(cf => {
              const storedField = buildStoredCustomField(cf);
              if (storedField) packageFields.push(storedField);
            });
          }

          const pkgData = {
            id: pkgIndex >= 0 ? mergedPackages[pkgIndex].id : (mergedPackages.length + 1),
            name: cleanPkgName,
            price: localPrice,
            usd_price: isUsdCategory ? localPrice : (apiCurrency === 'USD' ? apiPriceUsd : apiPriceUsd / rate),
            api_service_id: s.id.toString(),
            status: "Available",
            discount: discount,
            min_quantity: s.min_quantity,
            max_quantity: s.max_quantity,
            requires_quantity: s.requires_quantity,
            fields: packageFields
          };

          if (pkgIndex >= 0) {
            mergedPackages[pkgIndex] = pkgData;
          } else {
            mergedPackages.push(pkgData);
          }
        }

        const minPrice = mergedPackages.length > 0 ? Math.min(...mergedPackages.map(p => p.price)) : 0;

        if (existingService) {
          await runQuery(
            "UPDATE services SET packages = ?, fields = ?, price = ?, api_price = ? WHERE id = ?",
            [JSON.stringify(mergedPackages), JSON.stringify(combinedFields), minPrice, 0, existingService.id]
          );
          importedList.push({ id: existingService.id, name: cleanGroupName, status: 'updated_grouped' });
        } else {
          const svcInsert = await runQuery(
            "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              categoryId,
              cleanGroupName,
              `باقات وتفعيل خدمات ${cleanGroupName}`,
              minPrice,
              'default',
              JSON.stringify(mergedPackages),
              JSON.stringify(combinedFields),
              'fixed',
              0,
              'بيانات الخدمة',
              'grouped',
              'amrr-unlocker',
              0
            ]
          );
          importedList.push({ id: svcInsert.lastID, name: cleanGroupName, status: 'created_grouped' });
        }
      }
    } else {
      for (const s of services) {
        await new Promise(r => setImmediate(r));
        const serviceFields = [];
        const hasCustom = s.customFields && s.customFields.length > 0;

        if (hasCustom) {
          const seen = new Set();
          for (const cf of s.customFields) {
            const storedField = buildStoredCustomField(cf);
            if (!storedField) continue;
            const fieldId = storedField.id;
            const fieldLabel = String(storedField.api_name || '').toLowerCase().trim();
            if (seen.has(fieldId) || seen.has(fieldLabel)) continue;
            
            seen.add(fieldId);
            seen.add(fieldLabel);
            serviceFields.push(storedField);
          }
        }
        
        const fieldsJson = JSON.stringify(serviceFields);
        const cleanServiceName = s.name.replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim() || 'تفعيل فوري تلقائي';
        
        let categoryId = targetCategoryId;
        if (!categoryId) {
          const cleanCategoryName = (s.category || 'أدوات تخطي آيكلود').replace(/(amrr\s*-?\s*unlocker|amrr|ameer)/gi, '').replace(/\s+/g, ' ').trim() || s.category || 'أدوات تخطي آيكلود';
          let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [cleanCategoryName]);
          if (!cat) {
            const catInsert = await runQuery(
              "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false)",
              [cleanCategoryName, 'default', '#0284c7', 'credit-card', 'USD', fieldsJson, 'بيانات الخدمة']
            );
            categoryId = catInsert.lastID;
          } else {
            categoryId = cat.id;
          }
        }
        
        const categoryRow = await getQuery("SELECT currency FROM categories WHERE id = ?", [categoryId]);
        const categoryCurrency = categoryRow ? categoryRow.currency : 'USD';
        const isUsdCategory = categoryCurrency === 'USD';

        // Calculate pricing multiplier based on API account currency vs target category currency
        let multiplier = 1;
        if (apiCurrency === 'USD' && categoryCurrency === 'EGP') {
          multiplier = rate;
        } else if (apiCurrency === 'EGP' && categoryCurrency === 'USD') {
          multiplier = 1 / rate;
        }

        const apiPriceUsd = parseFloat(s.price) || 0;
        
        let localPrice;
        if (s.custom_price !== undefined && s.custom_price !== null) {
          localPrice = parseFloat(s.custom_price);
        } else {
          if (isUsdCategory) {
            localPrice = parseFloat(((apiPriceUsd * multiplier) * (1 + markup / 100)).toFixed(2));
          } else {
            localPrice = Math.ceil((apiPriceUsd * multiplier) * (1 + markup / 100));
          }
        }

        const discount = s.custom_discount !== undefined && s.custom_discount !== null ? parseFloat(s.custom_discount) : 0;
        
        const packagesJson = JSON.stringify([
          { 
            id: 1, 
            name: "تفعيل فوري تلقائي", 
            price: localPrice, 
            usd_price: isUsdCategory ? localPrice : (apiCurrency === 'USD' ? apiPriceUsd : apiPriceUsd / rate), 
            status: "Available", 
            discount: discount,
            min_quantity: s.min_quantity,
            max_quantity: s.max_quantity,
            requires_quantity: s.requires_quantity,
            fields: serviceFields
          }
        ]);
        
        const existingService = await getQuery(
          "SELECT id FROM services WHERE api_service_id = ? AND api_source = 'amrr-unlocker'",
          [s.id.toString()]
        );
        
        if (existingService) {
          await runQuery(
            "UPDATE services SET category_id = ?, name = ?, price = ?, api_price = ?, packages = ?, fields = ? WHERE id = ?",
            [categoryId, cleanServiceName, localPrice, apiPriceUsd, packagesJson, fieldsJson, existingService.id]
          );
          importedList.push({ id: existingService.id, name: cleanServiceName, status: 'updated' });
        } else {
          const svcInsert = await runQuery(
            "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              categoryId,
              cleanServiceName,
              `تفعيل خدمة ${cleanServiceName} فوري عبر API`,
              localPrice,
              'default',
              packagesJson,
              fieldsJson,
              'fixed',
              0,
              'بيانات الخدمة',
              s.id.toString(),
              'amrr-unlocker',
              apiPriceUsd
            ]
          );
          importedList.push({ id: svcInsert.lastID, name: cleanServiceName, status: 'created' });
        }
      }
    }
    
    res.json({
      success: true,
      message: `تم استيراد/تحديث عدد ${importedList.length} خدمة بنجاح.`,
      imported: importedList
    });
  } catch (error) {
    console.error('Import services error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء استيراد الخدمات إلى قاعدة البيانات.' });
  }
});

// 5. Place order on Amrr Unlocker (Admin Protected)
router.post('/place-order/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    // Clear any previous API error so the admin can force-retry after fixing the issue
    await runQuery("UPDATE orders SET api_status = NULL WHERE id = ? AND api_status LIKE 'API Error:%'", [id]);
    const result = await autoSubmitUnlockerOrder(id);
    if (!result.success) {
      return res.status(400).json({ message: result.error || 'فشل إرسال الطلب للمزود الخارجي.' });
    }
    res.json({
      success: true,
      message: 'تم إرسال الطلب بنجاح وهو الآن قيد المعالجة لدى المزود.',
      api_order_id: result.api_order_id,
      api_status: 'Pending'
    });
  } catch (error) {
    console.error('Place external order error:', error);
    res.status(500).json({ message: error.message || 'حدث خطأ أثناء إرسال الطلب إلى الخادم الخارجي.' });
  }
});

// 6. Check status and complete order (Admin Protected)
router.post('/check-status/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await checkAndUpdateOrder(id);
    res.json(result);
  } catch (error) {
    console.error('Check external order status error:', error);
    res.status(500).json({ message: error.message || 'حدث خطأ أثناء الاستعلام عن حالة الطلب.' });
  }
});

// Helper to get API Provider (with fallback for legacy amrr-unlocker)
async function resolveApiProvider(providerId, source) {
  let provider = null;
  if (providerId) {
    provider = await getQuery("SELECT * FROM api_providers WHERE id = ?", [providerId]);
  }
  if (!provider && (source === 'amrr-unlocker' || source === 'api_provider')) {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    provider = {
      api_key: apiKeyRow && apiKeyRow.value ? apiKeyRow.value : 'QNR-UP9-IU5-5BZ-1T-ZQZ-1DT-RIH',
      api_url: apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrrunlocker.com/api/index.php',
      username: apiUserRow && apiUserRow.value ? apiUserRow.value : ''
    };
  }
  return provider;
}

// Helper to check and update order status
async function checkAndUpdateOrder(orderId) {
  const order = await getQuery("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) {
    throw new Error('الطلب غير موجود.');
  }

  if (order.status === 'completed' || order.status === 'cancelled') {
    return {
      success: true,
      status: order.status,
      code: order.code || (order.status === 'completed' ? 'ACTIVATED' : 'Cancelled'),
      message: `هذا الطلب بالفعل في حالة '${order.status}' ومكتمل/ملغي مسبقاً ولا يحتاج تحديث أو استرداد رصيد.`
    };
  }
  
  if (!order.api_order_id || (!order.api_provider_id && order.api_source !== 'amrr-unlocker' && order.api_source !== 'api_provider')) {
    throw new Error('هذا الطلب غير مرتبط بطلب خارجي فعال.');
  }
  
  const provider = await resolveApiProvider(order.api_provider_id, order.api_source);
  if (!provider) {
    throw new Error('مزود الـ API المرتبط بهذا الطلب غير موجود.');
  }
  
  const apiKey = provider.api_key;
  const apiUrl = provider.api_url;
  const apiUser = provider.username;
  
  let responseData = await callDhruApi(apiUrl, apiUser, apiKey, 'getimeiorder', {
    ID: order.api_order_id
  }).catch(e => ({ ERROR: e.message }));
  
  let remoteOrder = null;
  if (responseData.SUCCESS && Array.isArray(responseData.SUCCESS)) {
    remoteOrder = responseData.SUCCESS[0];
  } else if (responseData.SUCCESS && typeof responseData.SUCCESS === 'object') {
    remoteOrder = responseData.SUCCESS;
  }
  
  // Automatic fallback to getserverorder and getremoteorder if getimeiorder didn't find the order
  if (!remoteOrder || responseData.ERROR) {
    const serverResp = await callDhruApi(apiUrl, apiUser, apiKey, 'getserverorder', {
      ID: order.api_order_id
    }).catch(e => ({ ERROR: e.message }));
    if (serverResp.SUCCESS && Array.isArray(serverResp.SUCCESS) && serverResp.SUCCESS[0]) {
      remoteOrder = serverResp.SUCCESS[0];
      responseData = serverResp;
    } else if (serverResp.SUCCESS && typeof serverResp.SUCCESS === 'object') {
      remoteOrder = serverResp.SUCCESS;
      responseData = serverResp;
    } else {
      const remoteResp = await callDhruApi(apiUrl, apiUser, apiKey, 'getremoteorder', {
        ID: order.api_order_id
      }).catch(e => ({ ERROR: e.message }));
      if (remoteResp.SUCCESS && Array.isArray(remoteResp.SUCCESS) && remoteResp.SUCCESS[0]) {
        remoteOrder = remoteResp.SUCCESS[0];
        responseData = remoteResp;
      } else if (remoteResp.SUCCESS && typeof remoteResp.SUCCESS === 'object') {
        remoteOrder = remoteResp.SUCCESS;
        responseData = remoteResp;
      }
    }
  }

  if (responseData.ERROR && !remoteOrder) {
    const errorMsg = getDhruErrorMessage(responseData);
    throw new Error(`فشل التحقق من الحالة: ${errorMsg}`);
  }
  
  if (!remoteOrder) {
    throw new Error('تعذر العثور على تفاصيل الطلب من الخادم الخارجي (تم الفحص عبر IMEI و Server و Remote).');
  }

  const statusVal = remoteOrder.STATUS || remoteOrder.status || remoteOrder.State || remoteOrder.state || '';
  let unlockCode = remoteOrder.CODE || remoteOrder.code || remoteOrder.result || remoteOrder.RESULT || remoteOrder.UNLOCKCODE || remoteOrder.unlockcode || '';
  
  if (!unlockCode) {
    const materials = [];
    const ignoreKeys = ['status', 'id', 'orderid', 'reference', 'action', 'message'];
    for (const [k, v] of Object.entries(remoteOrder)) {
      const key = k.toLowerCase();
      if (!ignoreKeys.includes(key) && v && typeof v === 'string') {
        if (key.includes('email') || key.includes('pass') || key.includes('user') || key.includes('pin') || key.includes('voucher') || key.includes('card') || key.includes('serial') || key.includes('data') || key.includes('key') || key.includes('token') || key.includes('license')) {
           materials.push(`${k}: ${v}`);
        }
      }
    }
    if (materials.length > 0) unlockCode = materials.join('\n');
  }
  const statusStr = String(statusVal).toLowerCase().trim();

  console.log(`[Check Order #${orderId}] Raw provider response:`, JSON.stringify(remoteOrder));
  console.log(`[Check Order #${orderId}] STATUS=${JSON.stringify(statusVal)} | CODE=${JSON.stringify(unlockCode)}`);

  // Explicit rejection: statuses 2, 3, or clear rejection keywords
  // NOTE: status 0 is NOT rejection — it means Pending at many providers
  const isRejected = statusVal === '2' || statusVal === 2 || statusVal === '3' || statusVal === 3
    || statusStr === 'rejected'
    || statusStr === 'cancelled'
    || statusStr === 'canceled'
    || statusStr === 'failed'
    || statusStr === 'invalid'
    || statusStr === 'refund'
    || (statusStr.includes('reject') && !statusStr.includes('not'))
    || (statusStr.includes('cancel') && !statusStr.includes('not'));

  if (isRejected) {
    await runQuery(
      "UPDATE orders SET api_status = 'Rejected' WHERE id = ?",
      [orderId]
    );
    return {
      success: true,
      status: order.status,
      api_status: 'Rejected',
      message: `تم رفض الطلب من المزود (حالة المزود: ${statusVal}).`
    };
  }

  // Dhru Fusion status codes:
  // 0 = Pending (NOT rejected! Some providers use 0 for new/pending orders)
  // 1 = In Process
  // 2 = Rejected
  // 3 = Rejected / Not Found
  // 4 = Success / Completed
  // 'rejected', 'cancel', 'fail', 'error' = explicit rejection

  const isCompleted = statusVal === '4' || statusVal === 4
    || statusStr.includes('complete')
    || statusStr.includes('success')
    || statusStr.includes('accept')
    || statusStr.includes('done')
    || (unlockCode && unlockCode.trim() !== '' && statusVal !== '0' && statusVal !== 0 && statusVal !== '1' && statusVal !== 1 && statusVal !== '2' && statusVal !== 2 && statusVal !== 'pending' && statusVal !== 'in process'); 
    // If we have a code and it's not pending/processing/rejected, it's done.
  
  if (isCompleted) {
    const finalCode = unlockCode || 'تم التنفيذ (مباشر)';
    const updateFields = "UPDATE orders SET status = 'completed', api_status = 'Completed', code = ? WHERE id = ?";
    await runQuery(updateFields, [finalCode, orderId]);

    // Notify customer!
    try {
      const notificationHelper = require('../utils/notificationHelper');
      await notificationHelper.notifyCustomerOfOrderUpdate(orderId, 'completed', unlockCode || '', order.download_link || '', order.download_link_title || '');
    } catch (err) {
      console.warn(`[Auto Sync Customer Notify Error] Failed to notify customer for completed order #${orderId}:`, err.message);
    }

    return {
      success: true,
      status: 'completed',
      api_status: 'Completed',
      code: unlockCode || '',
      message: `اكتمل الطلب لدى المزود ${unlockCode ? '— كود الفتح: ' + unlockCode : ''}`
    };
  }
  
  // Still processing: 0, 1, 2 or any other pending/process status
  const isInProcess = statusVal === '2' || statusVal === 2
    || statusStr.includes('process')
    || statusStr.includes('progress')
    || statusStr.includes('working');
  const displayStatus = isInProcess ? 'In Process' : 'Pending';
  await runQuery("UPDATE orders SET api_status = ? WHERE id = ?", [displayStatus, orderId]);
  
  return {
    success: true,
    status: 'processing',
    api_status: displayStatus,
    message: `الطلب لا يزال قيد المعالجة لدى المزود (حالة: ${statusVal}).`
  };
}

// Auto-submit helper function for external API orders
async function autoSubmitUnlockerOrder(orderId) {
  // --- Concurrency lock: prevent two simultaneous calls for the same order ---
  const lockKey = `order_${orderId}`;
  if (submittingOrders.has(lockKey)) {
    console.warn(`[Auto Place Order] Order #${orderId} already being submitted — skipping duplicate call.`);
    return { success: false, error: 'الطلب قيد الإرسال حالياً، يرجى الانتظار.' };
  }
  submittingOrders.add(lockKey);

  try {
    const order = await getQuery("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!order) {
      throw new Error('الطلب غير موجود.');
    }
    if (order.status !== 'pending') {
      throw new Error('يمكن فقط إرسال الطلبات التي في حالة الانتظار.');
    }
    // NOTE: We do NOT skip on api_status='API Error:' here.
    // The /place-order route clears that status before calling this function,
    // allowing admin force-retries. The auto-trigger path (order approval)
    // should still skip to avoid hammering the provider on duplicate events.
    
    const service = await getQuery("SELECT api_service_id, api_source, api_service_type, packages, fields, api_provider_id FROM services WHERE id = ?", [order.service_id]);
    if (!service) {
      throw new Error('الخدمة غير موجودة.');
    }

    let targetApiServiceId = service.api_service_id;
    // Default service type from the service row, may be overridden by package
    let targetServiceType = service.api_service_type || 'imei';
    let targetApiQuantity = order.quantity ? parseInt(order.quantity) : 1;

    if (order.package_name) {
      try {
        const pkgs = typeof service.packages === 'string' ? JSON.parse(service.packages) : (service.packages || []);
        let matchingPkg = pkgs.find(p => String(p.name).trim().toLowerCase() === String(order.package_name).trim().toLowerCase());
        
        if (!matchingPkg) {
          matchingPkg = pkgs.find(p => String(p.name).trim().toLowerCase().includes(String(order.package_name).trim().toLowerCase()) || String(order.package_name).trim().toLowerCase().includes(String(p.name).trim().toLowerCase()));
        }

        if (matchingPkg) {
          if (matchingPkg.api_service_id) targetApiServiceId = matchingPkg.api_service_id;
          if (matchingPkg.api_service_type) targetServiceType = matchingPkg.api_service_type;
          
          // If the package is fixed (doesn't require user quantity), use the min_quantity defined by the provider
          if (!matchingPkg.requires_quantity && matchingPkg.min_quantity) {
             const minQ = parseInt(matchingPkg.min_quantity);
             if (minQ > 0) {
               // If user ordered multiple of this fixed package, multiply the quantity if the API allows it,
               // but usually for fixed Dhru packages (min=max), it's just minQ. 
               // For safety against 'Wrong Qnt range', we'll just send min_quantity.
               targetApiQuantity = minQ * (order.quantity ? parseInt(order.quantity) : 1);
             }
          }
        }
      } catch (e) {
        console.error('Failed to parse service packages for external order lookup:', e.message);
      }
    }

    if (!targetApiServiceId || targetApiServiceId === 'grouped') {
      throw new Error('تعذر تحديد معرّف الخدمة الخارجي (API Service ID) لهذه الحزمة.');
    }
    
    const provider = await resolveApiProvider(service.api_provider_id, service.api_source);
    if (!provider) {
      throw new Error('مزود الـ API المرتبط بهذا الطلب غير موجود.');
    }
    
    const apiKey = provider.api_key;
    const apiUrl = provider.api_url;
    const apiUser = provider.username;
    
    const trimmedPlayerId = (order.player_id || '').trim();

    const parseStoredFields = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value !== 'string' || !value.trim()) return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    };

    const storedServiceFields = parseStoredFields(service.fields);
    let selectedPackageFields = [];
    try {
      const storedPackages = typeof service.packages === 'string' ? JSON.parse(service.packages) : (service.packages || []);
      const selectedPackage = storedPackages.find(pkg =>
        String(pkg.name || '').trim().toLowerCase() === String(order.package_name || '').trim().toLowerCase()
      ) || storedPackages.find(pkg =>
        String(pkg.name || '').trim().toLowerCase().includes(String(order.package_name || '').trim().toLowerCase())
      );
      selectedPackageFields = parseStoredFields(selectedPackage?.fields);
    } catch (e) {
      selectedPackageFields = [];
    }

    const normalizeProviderFieldLookupKey = (value) => String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^custom_/, '')
      .replace(/[.\-_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const providerFieldNames = new Map();
    for (const field of (selectedPackageFields.length > 0 ? selectedPackageFields : storedServiceFields)) {
      const apiName = String(field.api_name || field.label || field.field_id || field.name || '').trim();
      if (!apiName) continue;
      for (const key of [field.id, field.name, field.field_id, field.label, apiName]) {
        if (!key) continue;
        providerFieldNames.set(String(key).toLowerCase(), apiName);
        providerFieldNames.set(normalizeProviderFieldLookupKey(key), apiName);
      }
    }

    const isPrimaryImeiField = (field) => {
      const combined = String(
        field?.api_name || field?.label || field?.field_id || field?.name || ''
      )
        .trim()
        .toLowerCase();

      if (!combined) return false;
      if (/(link|url|http|https|screenshot|hint)/i.test(combined)) return false;
      return combined.includes('imei') || combined.includes('ecid') || combined.includes('serial number') || /\bsn\b/.test(combined);
    };

    // Build custom fields object from order.custom_fields
    // IMPORTANT: Exclude standard fields (player_id, phone) — they are sent as IMEI/QNT directly.
    // Use the field_id (stripped of 'custom_' prefix) as the API key, since that is what
    // the Dhru Fusion provider registered in their service definition.
    const SKIP_FIELDS = new Set(['player_id', 'phone', 'tel', 'sender_phone']);
    let customFields = {};
    if (order.custom_fields) {
      try {
        const parsed = typeof order.custom_fields === 'string' ? JSON.parse(order.custom_fields) : order.custom_fields;
        
        // Backward compatibility for old orders where CUSTOMFIELD was saved as base64 string
        if (parsed && typeof parsed === 'object' && parsed.CUSTOMFIELD) {
            try {
                const decoded = Buffer.from(parsed.CUSTOMFIELD, 'base64').toString('utf8');
                const innerJson = JSON.parse(decoded);
                Object.assign(parsed, innerJson);
                delete parsed.CUSTOMFIELD;
            } catch(e) {
                console.warn('[Auto Place Order] Failed to decode old CUSTOMFIELD:', e.message);
            }
        }

        for (const [k, v] of Object.entries(parsed)) {
          const rawKey = k.startsWith('custom_') ? k.replace('custom_', '') : k;
          const normalizedLookupKey = normalizeProviderFieldLookupKey(k);
          const normalizedRawLookupKey = normalizeProviderFieldLookupKey(rawKey);
          const providerKey = providerFieldNames.get(String(k).toLowerCase())
            || providerFieldNames.get(String(rawKey).toLowerCase())
            || providerFieldNames.get(normalizedLookupKey)
            || providerFieldNames.get(normalizedRawLookupKey)
            || rawKey;
          // Skip standard/system fields and empty values
          if (SKIP_FIELDS.has(rawKey.toLowerCase()) || SKIP_FIELDS.has(k.toLowerCase()) || SKIP_FIELDS.has(providerKey.toLowerCase())) continue;
          if (v === null || v === undefined || String(v).trim() === '') continue;
          customFields[providerKey] = String(v).trim();
        }
      } catch (e) {
        console.warn('[Auto Place Order] Failed to parse custom fields:', e.message);
      }
    }

    const requiredProviderFields = (selectedPackageFields.length > 0 ? selectedPackageFields : storedServiceFields)
      .filter((field) => field && field.required !== false)
      .filter((field) => !isPrimaryImeiField(field))
      .map((field) => String(field.api_name || field.label || field.field_id || field.name || '').trim())
      .filter(Boolean);

    const missingProviderFields = requiredProviderFields.filter((fieldName) => {
      const lookupKey = normalizeProviderFieldLookupKey(fieldName);
      return !Object.keys(customFields).some((existingKey) => normalizeProviderFieldLookupKey(existingKey) === lookupKey && String(customFields[existingKey] || '').trim());
    });

    if (missingProviderFields.length > 0) {
      throw new Error(`الحقول المطلوبة للمزود ناقصة: ${missingProviderFields.join('، ')}`);
    }

    const buildCustomField = (fields) => {
      if (!fields || Object.keys(fields).length === 0) return undefined;
      return Buffer.from(JSON.stringify(fields)).toString('base64');
    };

    const customFieldEncoded = buildCustomField(customFields);

    // ── Order Placement Logic ─────────────────────────────────────────────
    console.log(`[Auto Place Order #${orderId}] ServiceType=${targetServiceType} | ServiceID=${targetApiServiceId} | IMEI=${trimmedPlayerId} | CustomFields=${JSON.stringify(customFields)}`);

    let responseData = null;

    if (provider.provider_type === 'dynamic') {
      try {
        console.log(`[Auto Place Order #${orderId}] Trying placeDynamicOrder`);
        const result = await placeDynamicOrder(provider, { api_service_id: targetApiServiceId }, {
          link: trimmedPlayerId,
          quantity: targetApiQuantity,
          customFields: customFields
        });
        responseData = { SUCCESS: [{ REFERENCEID: result.order_id }] };
      } catch (err) {
        responseData = { ERROR: err.message };
      }
    } else if (targetServiceType === 'server' || targetServiceType === 'remote') {
      // ── Server Order (primary) ─────────────────────────────────────────────
      const serverFields = { ...customFields };
      if (trimmedPlayerId) {
        const hasKey = Object.keys(serverFields).some(k => k.toLowerCase().includes('player') || k.toLowerCase().includes('id') || k.toLowerCase().includes('imei'));
        if (!hasKey) {
          const targetFields = selectedPackageFields.length > 0 ? selectedPackageFields : storedServiceFields;
          const primaryField = targetFields.find(f => String(f.name || f.api_name || f.field_id || '').toLowerCase().includes('player')) || targetFields[0];
          if (primaryField) {
             const apiName = String(primaryField.api_name || primaryField.label || primaryField.field_id || primaryField.name || '').trim();
             serverFields[apiName || 'PlayerID'] = trimmedPlayerId;
          } else {
             serverFields.PlayerID = trimmedPlayerId;
          }
        }
      }
      const serverPayload = {
        ID: targetApiServiceId,
        QNT: targetApiQuantity,
        REFERENCE: order.id.toString(),
        ...(customFieldEncoded ? { CUSTOMFIELD: customFieldEncoded } : {}),
        ...serverFields
      };
      console.log(`[Auto Place Order #${orderId}] Trying placeserverorder | QNT=${targetApiQuantity}`);
      responseData = await callDhruApi(apiUrl, apiUser, apiKey, 'placeserverorder', serverPayload).catch(e => ({ ERROR: e.message }));
      
      if (responseData.ERROR) {
        let firstError = responseData;
        console.warn(`[Auto Place Order #${orderId}] placeserverorder failed (${getDhruErrorMessage(firstError)}), trying placeimeiorder as fallback...`);
        const fallbackImei = trimmedPlayerId || '000000000000000';
        const imeiPayload = {
          ID: targetApiServiceId,
          IMEI: fallbackImei,
          REFERENCE: order.id.toString(),
          ...(customFieldEncoded ? { CUSTOMFIELD: customFieldEncoded } : {}),
          ...customFields
        };
        responseData = await callDhruApi(apiUrl, apiUser, apiKey, 'placeimeiorder', imeiPayload).catch(e => ({ ERROR: e.message }));
        
        if (responseData.ERROR && (getDhruErrorMessage(responseData).includes("Command Not Found") || getDhruErrorMessage(responseData).includes("Action Not Found") || getDhruErrorMessage(responseData).includes("Service Not Active") || getDhruErrorMessage(responseData).includes("Action is not allowed"))) {
          // Restore original error if fallback action doesn't exist or service not active for it
          responseData = firstError;
        }
      }
    } else {
      // ── IMEI Order (primary, default) ─────────────────────────────────────
      const fallbackImei = trimmedPlayerId || '000000000000000';
      const imeiPayload = {
        ID: targetApiServiceId,
        IMEI: fallbackImei,
        REFERENCE: order.id.toString(),
        ...(customFieldEncoded ? { CUSTOMFIELD: customFieldEncoded } : {}),
        ...customFields
      };
      console.log(`[Auto Place Order #${orderId}] Trying placeimeiorder | IMEI=${fallbackImei}`);
      responseData = await callDhruApi(apiUrl, apiUser, apiKey, 'placeimeiorder', imeiPayload).catch(e => ({ ERROR: e.message }));

      // ── Server Order Fallback ──────────────────────────────────────────────
      if (responseData.ERROR) {
        let firstError = responseData;
        console.warn(`[Auto Place Order #${orderId}] placeimeiorder failed (${getDhruErrorMessage(firstError)}), trying placeserverorder as fallback...`);
        const serverFields = { ...customFields };
        if (trimmedPlayerId) {
          const hasKey = Object.keys(serverFields).some(k => k.toLowerCase().includes('player') || k.toLowerCase().includes('id') || k.toLowerCase().includes('imei'));
          if (!hasKey) {
            const targetFields = selectedPackageFields.length > 0 ? selectedPackageFields : storedServiceFields;
            const primaryField = targetFields.find(f => String(f.name || f.api_name || f.field_id || '').toLowerCase().includes('player')) || targetFields[0];
            if (primaryField) {
               const apiName = String(primaryField.api_name || primaryField.label || primaryField.field_id || primaryField.name || '').trim();
               serverFields[apiName || 'PlayerID'] = trimmedPlayerId;
            } else {
               serverFields.PlayerID = trimmedPlayerId;
            }
          }
        }
        const serverPayload = { ID: targetApiServiceId, QNT: targetApiQuantity, REFERENCE: order.id.toString(), ...serverFields };
        if (customFieldEncoded) {
          serverPayload.CUSTOMFIELD = customFieldEncoded;
        }
        responseData = await callDhruApi(apiUrl, apiUser, apiKey, 'placeserverorder', serverPayload).catch(e => ({ ERROR: e.message }));
        
        if (responseData.ERROR && (getDhruErrorMessage(responseData).includes("Command Not Found") || getDhruErrorMessage(responseData).includes("Action Not Found") || getDhruErrorMessage(responseData).includes("Service Not Active") || getDhruErrorMessage(responseData).includes("Action is not allowed"))) {
          responseData = firstError;
        }
      }
    }
    
    if (responseData.ERROR) {
      const errorMsg = getDhruErrorMessage(responseData);
      throw new Error(`فشل إرسال الطلب للمزود: ${errorMsg}`);
    }
    
    let apiOrderId = '';
    if (responseData.SUCCESS && Array.isArray(responseData.SUCCESS)) {
      const first = responseData.SUCCESS[0];
      console.log('[Dhru API] Order placement success response (nested SUCCESS):', JSON.stringify(first));
      apiOrderId = first.id || first.ID || first.orderid || first.ORDERID || first.order_id || first.ORDER_ID || first.REFERENCEID || first.referenceid || '';
    } else if (responseData.SUCCESS && typeof responseData.SUCCESS === 'object') {
      const first = responseData.SUCCESS;
      apiOrderId = first.id || first.ID || first.orderid || first.ORDERID || first.order_id || first.ORDER_ID || first.REFERENCEID || first.referenceid || '';
    }
    if (!apiOrderId) {
      console.log('[Dhru API] Order placement success response (root):', JSON.stringify(responseData));
      apiOrderId = responseData.id || responseData.ID || responseData.orderid || responseData.ORDERID || responseData.order_id || responseData.ORDER_ID || responseData.REFERENCEID || responseData.referenceid || '';
    }
    
    if (!apiOrderId) {
      throw new Error('نجح الطلب ولكن تعذر الحصول على رقم الطلب الخارجي.');
    }
    
    await runQuery(
      "UPDATE orders SET status = 'processing', api_order_id = ?, api_source = 'api_provider', api_provider_id = ?, api_status = 'Pending' WHERE id = ?",
      [apiOrderId.toString(), provider.id, orderId]
    );
    
    submittingOrders.delete(lockKey); // Release lock on success
    return { success: true, api_order_id: apiOrderId };
  } catch (err) {
    console.error(`[Auto Place Order Error] Order #${orderId}:`, err.message);

    // Other errors: just record the api_status, keep order pending for admin review
    await runQuery("UPDATE orders SET api_status = ? WHERE id = ?", [`API Error: ${err.message}`, orderId]);

    submittingOrders.delete(lockKey); // Release lock on failure
    return { success: false, error: err.message };
  }
}


// Attach helpers to router
router.autoSubmitUnlockerOrder = autoSubmitUnlockerOrder;
router.checkAndUpdateOrder = checkAndUpdateOrder;

// ── Startup Auto-Sync Hook (Run once 20 seconds after Docker startup) ───────
setTimeout(async () => {
  console.log('[Startup Auto-Sync] Starting automatic sync for processing orders and services on startup...');
  try {
    const processingOrders = await allQuery(
      "SELECT id FROM orders WHERE status = 'processing' AND api_provider_id IS NOT NULL AND api_order_id IS NOT NULL"
    );
    for (const o of processingOrders) {
      console.log(`[Startup Auto-Sync] Checking status for order #${o.id}...`);
      try {
        await checkAndUpdateOrder(o.id);
      } catch (err) {
        console.error(`[Startup Auto-Sync Error] Order #${o.id}:`, err.message);
      }
    }
    console.log('[Startup Auto-Sync] Completed startup order status check successfully.');
  } catch (err) {
    console.error('[Startup Auto-Sync Global Error]:', err.message);
  }
}, 20000);

// Start automated background polling every 2 minutes
setInterval(async () => {
  try {
    const processingOrders = await allQuery(
      "SELECT id FROM orders WHERE status = 'processing' AND api_provider_id IS NOT NULL AND api_order_id IS NOT NULL"
    );
    for (const o of processingOrders) {
      console.log(`[Auto Poll] Checking status for order #${o.id}...`);
      try {
        await checkAndUpdateOrder(o.id);
      } catch (err) {
        console.error(`[Auto Poll Error] Order #${o.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Auto Poll Global Error]:', err.message);
  }
}, 30000); // every 30 seconds

// ── Cancel Order from External Provider ─────────────────────────────────────
router.post('/cancel-order/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  
  try {
    const order = await getQuery("SELECT * FROM orders WHERE id = ?", [id]);
    if (!order) {
      return res.status(404).json({ message: 'الطلب غير موجود.' });
    }
    
    // Only allow cancelling orders that are pending or processing
    if (!['pending', 'processing'].includes(order.status)) {
      return res.status(400).json({ message: 'لا يمكن إلغاء طلب في هذه الحالة. يمكن فقط إلغاء الطلبات المعلقة أو قيد المعالجة.' });
    }
    
    // If order has an external API order ID, try to cancel it from the provider
    if (order.api_order_id) {
      const provider = await resolveApiProvider(order.api_provider_id, order.api_source);
      if (!provider) {
        return res.status(404).json({ message: 'مزود الـ API المرتبط بالطلب غير موجود.' });
      }
      
      const apiKey = provider.api_key;
      const apiUrl = provider.api_url;
      const apiUser = provider.username;
      
      try {
        let responseData = await callDhruApi(apiUrl, apiUser, apiKey, 'cancelimeiorder', {
          ID: order.api_order_id
        });
        
        if (responseData.ERROR) {
          const serverCancel = await callDhruApi(apiUrl, apiUser, apiKey, 'cancelserverorder', {
            ID: order.api_order_id
          }).catch(e => ({ ERROR: e.message }));
          if (!serverCancel.ERROR) {
            responseData = serverCancel;
          } else {
            const remoteCancel = await callDhruApi(apiUrl, apiUser, apiKey, 'cancelremoteorder', {
              ID: order.api_order_id
            }).catch(e => ({ ERROR: e.message }));
            if (!remoteCancel.ERROR) {
              responseData = remoteCancel;
            }
          }
        }
        
        console.log('[Dhru API] Cancel order response:', JSON.stringify(responseData));
        
        if (responseData.ERROR) {
          const errorMsg = getDhruErrorMessage(responseData);
          console.warn(`[Cancel Order] Provider rejection for order #${id}: ${errorMsg}`);
        }
      } catch (apiErr) {
        console.error(`[Cancel Order] Failed to cancel from provider for order #${id}:`, apiErr.message);
      }
    }
    
    const wasAlreadyCancelled = order.status === 'cancelled';

    // Update order status to 'cancelled'
    await runQuery("UPDATE orders SET status = 'cancelled', api_status = 'Cancelled' WHERE id = ?", [id]);

    // Notify customer!
    try {
      const notificationHelper = require('../utils/notificationHelper');
      await notificationHelper.notifyCustomerOfOrderUpdate(id, 'cancelled');
    } catch (err) {
      console.warn(`[Cancel API Order Customer Notify Error] Failed to notify customer for cancelled order #${id}:`, err.message);
    }
    
    // Refund the customer's wallet balance if not already cancelled
    if (!wasAlreadyCancelled && order.payment_method === 'wallet' && order.customer_id) {
      try {
        const customer = await getQuery("SELECT * FROM customers WHERE id = ?", [order.customer_id]);
        if (customer) {
          const refundAmount = Number(order.package_price) || 0;
          if (refundAmount > 0) {
            const oldBalance = Number(customer.balance) || 0;
            const newBalance = oldBalance + refundAmount;
            await runQuery("UPDATE customers SET balance = balance + ? WHERE id = ?", [refundAmount, customer.id]);
            
            // Log the refund transaction
            await runQuery(
              "INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                customer.id,
                customer.username,
                'credit',
                refundAmount,
                oldBalance,
                newBalance,
                'order_refund',
                order.id,
                `استرداد رصيد - إلغاء طلب API #${order.id}`
              ]
            );
            
            console.log(`[Cancel Order] Refunded $${refundAmount} to customer #${customer.id} for order #${id}`);
          }
        }
      } catch (refundErr) {
        console.error(`[Cancel Order] Refund error for order #${id}:`, refundErr.message);
      }
    }
    
    res.json({
      success: true,
      message: `تم إلغاء الطلب #${id} بنجاح واسترداد الرصيد.`
    });
    
  } catch (err) {
    console.error(`[Cancel Order] Error cancelling order #${id}:`, err.message);
    res.status(500).json({ message: `فشل إلغاء الطلب: ${err.message}` });
  }
});

router.performSmartSync = performSmartSync;

// DUMP ZKEY
router.get('/dump-zkey', async (req, res) => {
  try {
    const apiKeyRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_key'");
    const apiUrlRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_api_url'");
    const apiUserRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_unlocker_username'");
    
    const apiKey = apiKeyRow && apiKeyRow.value ? apiKeyRow.value : '5TC-O62-NRZ-HF3-NQ4-3VJ-S7V-FPK';
    const apiUrl = apiUrlRow && apiUrlRow.value ? apiUrlRow.value : 'https://amrr-unlocker.com/api/index.php';
    const apiUser = apiUserRow && apiUserRow.value ? apiUserRow.value : 'Hassen1990';
    
    // Attempt to format URL safely
    let safeUrl = apiUrl;
    if (!safeUrl.startsWith('http://') && !safeUrl.startsWith('https://')) {
      safeUrl = 'https://' + safeUrl;
    }
    
    const data = await callDhruApi(safeUrl, apiUser, apiKey, 'serverservicelist');
    const zkey = [];
    if (data && data.SUCCESS && data.SUCCESS[0] && data.SUCCESS[0].LIST) {
      const groups = data.SUCCESS[0].LIST;
      for (const group of groups) {
        if (group.SERVICES) {
          for (const s of group.SERVICES) {
            if (s.SERVICENAME && s.SERVICENAME.toLowerCase().includes('zkey')) {
              zkey.push(s);
            }
          }
        }
      }
    }
    res.json({ url_used: safeUrl, raw_amrr: { api_url: safeUrl, api_username: apiUser, api_key: apiKey }, zkey: zkey });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

module.exports = router;
