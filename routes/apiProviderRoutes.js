const express = require('express');
const router = express.Router();
const { runQuery, allQuery, getQuery } = require('../db');
const authMiddleware = require('../middleware/auth');
const { callDhruApi, parseDhruServices } = require('../services/dhruClient');

// Get all API Providers (Admin Protected)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const providers = await allQuery('SELECT * FROM api_providers ORDER BY id DESC');
    res.json(providers || []);
  } catch (error) {
    console.error('Fetch API providers error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب مزودي الـ API.' });
  }
});

// Add new API Provider (Admin Protected)
router.post('/', authMiddleware, async (req, res) => {
  const { name, api_url, username, api_key } = req.body;
  if (!name || !api_url || !api_key) {
    return res.status(400).json({ message: 'الاسم، الرابط، ومفتاح API مطلوبين.' });
  }

  try {
    const result = await runQuery(
      'INSERT INTO api_providers (name, api_url, username, api_key) VALUES (?, ?, ?, ?) RETURNING id',
      [name.trim(), api_url.trim(), username ? username.trim() : '', api_key.trim()]
    );
    // runQuery returns the first row for INSERT ... RETURNING id in db.js patchedRunQuery
    const newId = result ? (result.id || result.lastID) : null; 
    res.status(201).json({ message: 'تم إضافة مزود الـ API بنجاح.', id: newId });
  } catch (error) {
    console.error('Add API provider error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء إضافة المزود.' });
  }
});

// Update API Provider (Admin Protected)
router.put('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, api_url, username, api_key, is_active } = req.body;

  try {
    const provider = await getQuery('SELECT * FROM api_providers WHERE id = ?', [id]);
    if (!provider) return res.status(404).json({ message: 'المزود غير موجود.' });

    await runQuery(
      'UPDATE api_providers SET name = ?, api_url = ?, username = ?, api_key = ?, is_active = ? WHERE id = ?',
      [
        name ? name.trim() : provider.name,
        api_url ? api_url.trim() : provider.api_url,
        username !== undefined ? username.trim() : provider.username,
        api_key ? api_key.trim() : provider.api_key,
        is_active !== undefined ? is_active : provider.is_active,
        id
      ]
    );
    res.json({ message: 'تم تحديث المزود بنجاح.' });
  } catch (error) {
    console.error('Update API provider error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء تحديث المزود.' });
  }
});

// Delete API Provider (Admin Protected)
router.delete('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    await runQuery('DELETE FROM api_providers WHERE id = ?', [id]);
    await runQuery('UPDATE services SET api_provider_id = NULL WHERE api_provider_id = ?', [id]);
    await runQuery('UPDATE orders SET api_provider_id = NULL WHERE api_provider_id = ?', [id]);
    res.json({ message: 'تم حذف المزود بنجاح.' });
  } catch (error) {
    console.error('Delete API provider error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء حذف المزود.' });
  }
});

// Check Balance of an API Provider (Admin Protected)
router.get('/:id/balance', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const provider = await getQuery('SELECT * FROM api_providers WHERE id = ?', [id]);
    if (!provider) return res.status(404).json({ message: 'المزود غير موجود.' });

    let responseData;
    try {
      responseData = await callDhruApi(provider.api_url, provider.username, provider.api_key, 'accountinfo');
    } catch (err) {
      console.error(`[API Provider Error - Balance] ID: ${id}, Error: ${err.message}`);
      return res.status(400).json({ message: 'فشل الاتصال بالمزود: ' + err.message });
    }

    if (responseData.ERROR) {
      console.error(`[API Provider Error - Balance] ID: ${id}, Provider Error:`, responseData.ERROR);
      return res.status(400).json({ message: 'خطأ من المزود: ' + JSON.stringify(responseData.ERROR) });
    }

    let info = null;
    if (responseData.SUCCESS && Array.isArray(responseData.SUCCESS)) {
      info = responseData.SUCCESS[0]?.AccountInfo || null;
    }

    if (!info) {
      return res.status(400).json({ message: 'تعذر الحصول على معلومات الحساب.' });
    }

    const creditRaw = parseFloat(info.creditraw) || 0;
    const currency = info.currency || 'USD';

    await runQuery('UPDATE api_providers SET balance = ?, currency = ? WHERE id = ?', [creditRaw, currency, id]);

    res.json({
      success: true,
      credit: info.credit ? info.credit.trim() : `$${creditRaw}`,
      credit_raw: creditRaw,
      currency: currency,
      email: info.mail || ''
    });
  } catch (error) {
    console.error('Check API provider balance error:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب الرصيد.' });
  }
});

// Core Smart Sync Logic adapted for a specific provider
async function performProviderSync(providerId, customRate, customMarkup, customShouldGroup) {
  const provider = await getQuery('SELECT * FROM api_providers WHERE id = ?', [providerId]);
  if (!provider) throw new Error('المزود غير موجود في قاعدة البيانات.');

  const rateRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_exchange_rate'");
  const markupRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_markup_percent'");
  const groupRow = await getQuery("SELECT value FROM settings WHERE key = 'amrr_group_as_packages'");
  
  const rate = customRate !== undefined ? parseFloat(customRate) : (rateRow ? parseFloat(rateRow.value) : 50);
  const markup = customMarkup !== undefined ? parseFloat(customMarkup) : (markupRow ? parseFloat(markupRow.value) : 10);
  const shouldGroup = customShouldGroup !== undefined ? customShouldGroup : (groupRow ? groupRow.value === 'true' : true);

  console.log(`[Smart Sync] Fetching fresh services list from provider ${provider.name}...`);
  const [imeiRes, serverRes, remoteRes] = await Promise.all([
    callDhruApi(provider.api_url, provider.username, provider.api_key, 'imeiservicelist').catch(e => ({ ERROR: e.message })),
    callDhruApi(provider.api_url, provider.username, provider.api_key, 'serverservicelist').catch(e => ({ ERROR: e.message })),
    callDhruApi(provider.api_url, provider.username, provider.api_key, 'remoteservicelist').catch(e => ({ ERROR: e.message }))
  ]);

  const allServices = [
    ...parseDhruServices(imeiRes, 'imei'),
    ...parseDhruServices(serverRes, 'server'),
    ...parseDhruServices(remoteRes, 'remote')
  ];

  if (allServices.length === 0) {
    throw new Error('تعذر جلب الخدمات من المزود، تأكد من الاتصال أو المفاتيح.');
  }

  let apiCurrency = provider.currency || 'USD';
  try {
    const balanceData = await callDhruApi(provider.api_url, provider.username, provider.api_key, 'accountinfo');
    if (balanceData && balanceData.SUCCESS && Array.isArray(balanceData.SUCCESS)) {
      apiCurrency = balanceData.SUCCESS[0]?.AccountInfo?.currency || 'USD';
      await runQuery('UPDATE api_providers SET balance = ?, currency = ? WHERE id = ?', [parseFloat(balanceData.SUCCESS[0].AccountInfo.creditraw), apiCurrency, provider.id]);
    }
  } catch (e) {
    console.warn('Failed to fetch provider currency, defaulting to USD');
  }

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
            const fieldId = `custom_${cf.field_id || cf.fieldname}`;
            const fieldLabel = String(cf.fieldname || '').toLowerCase().trim();
            if (!addedFieldNames.has(fieldId) && !addedFieldNames.has(fieldLabel)) {
              addedFieldNames.add(fieldId);
              addedFieldNames.add(fieldLabel);
              combinedFields.push({
                id: fieldId,
                name: fieldId,
                label: cf.fieldname,
                placeholder: cf.description || `أدخل ${cf.fieldname}`,
                type: cf.fieldtype === 'select' ? 'select' : (cf.fieldtype === 'textarea' ? 'textarea' : 'text'),
                options: cf.fieldoptions ? cf.fieldoptions.split(',').map(o => o.trim()) : [],
                required: cf.required === 'on'
              });
            }
          }
        }
      }

      if (combinedFields.length === 0) {
        const dominantTypeEarly = Object.entries(
          groupServices.reduce((acc, s) => { const t = s.serviceType || 'imei'; acc[t] = (acc[t] || 0) + 1; return acc; }, {})
        ).sort((a, b) => b[1] - a[1])[0]?.[0] || 'imei';
        if (dominantTypeEarly === 'imei') {
          combinedFields.push({ id: 'imei', name: 'imei', label: 'IMEI / SN / ECID', placeholder: 'أدخل رقم IMEI أو الرقم التسلسلي (SN) أو ECID', type: 'text', required: true });
        } else {
          combinedFields.push({ id: 'player_id', name: 'player_id', label: 'معرّف الجهاز / ID', placeholder: 'أدخل معرّف الجهاز بدقة هنا', type: 'text', required: true });
        }
      }

      let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [cleanGroupName]);
      let categoryId;
      if (!cat) {
        const catInsert = await runQuery(
          "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false) RETURNING id",
          [cleanGroupName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify(combinedFields), 'بيانات الخدمة']
        );
        categoryId = catInsert ? (catInsert.id || catInsert.lastID) : null;
        addedCategoriesCount++;
      } else {
        categoryId = cat.id;
        await runQuery("UPDATE categories SET fields = ? WHERE id = ?", [JSON.stringify(combinedFields), categoryId]);
      }

      const mergedPackages = [];
      let multiplier = 1;
      if (apiCurrency === 'EGP') multiplier = 1 / rate;

      groupServices.forEach((s, idx) => {
        const apiPriceUsd = parseFloat(s.price) || 0;
        const localPrice = parseFloat((apiPriceUsd * multiplier * (1 + markup / 100)).toFixed(2));
        const cleanPkgName = s.name || 'تفعيل فوري تلقائي';
        const isDynamicPkg = (s.max_quantity > 1 && s.max_quantity !== s.min_quantity) || (s.min_quantity > 1 && s.max_quantity === 0) || s.requires_quantity;

        const packageFields = [];
        if (s.customFields && s.customFields.length > 0) {
          s.customFields.forEach(cf => {
            const fieldId = `custom_${cf.field_id || cf.fieldname}`;
            packageFields.push({
              id: fieldId,
              name: fieldId,
              label: cf.fieldname,
              placeholder: cf.description || `أدخل ${cf.fieldname}`,
              type: cf.fieldtype === 'select' ? 'select' : (cf.fieldtype === 'textarea' ? 'textarea' : 'text'),
              options: cf.fieldoptions ? cf.fieldoptions.split(',').map(o => o.trim()) : [],
              required: cf.required === 'on'
            });
          });
        }

        mergedPackages.push({
          id: idx + 1,
          name: cleanPkgName,
          price: localPrice,
          usd_price: localPrice,
          api_service_id: s.id.toString(),
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
      
      const typeCounts = groupServices.reduce((acc, s) => { const t = s.serviceType || 'imei'; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
      const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'imei';

      let existingSvc = await getQuery("SELECT id FROM services WHERE name = ? AND api_provider_id = ? AND api_service_id = 'grouped'", [cleanGroupName, provider.id]);
      
      if (!existingSvc) {
        await runQuery(
          "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_provider_id, api_price, min_quantity, max_quantity, api_service_type, api_delivery_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [categoryId, cleanGroupName, `باقات وتفعيل خدمات ${cleanGroupName}`, minPrice, 'default', packagesJson, fieldsJson, 'fixed', 0, 'بيانات الخدمة', 'grouped', 'api_provider', provider.id, 0, 1, 0, dominantType, '']
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
        const catInsert = await runQuery(
          "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false) RETURNING id",
          [cleanCategoryName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify([]), 'بيانات الخدمة']
        );
        categoryId = catInsert ? (catInsert.id || catInsert.lastID) : null;
        addedCategoriesCount++;
      } else {
        categoryId = cat.id;
      }

      const serviceFields = [];
      if (s.customFields && Array.isArray(s.customFields)) {
        s.customFields.forEach(cf => {
          const fieldId = `custom_${cf.field_id || cf.fieldname}`;
          serviceFields.push({
            id: fieldId,
            name: fieldId,
            label: cf.fieldname,
            placeholder: cf.description || `أدخل ${cf.fieldname}`,
            type: cf.fieldtype === 'select' ? 'select' : (cf.fieldtype === 'textarea' ? 'textarea' : 'text'),
            options: cf.fieldoptions ? cf.fieldoptions.split(',').map(o => o.trim()) : [],
            required: cf.required === 'on'
          });
        });
      }
      if (serviceFields.length === 0) {
        if ((s.serviceType || 'imei') === 'imei') {
          serviceFields.push({ id: 'imei', name: 'imei', label: 'IMEI / SN / ECID', placeholder: 'أدخل رقم IMEI أو الرقم التسلسلي (SN) أو ECID', type: 'text', required: true });
        } else {
          serviceFields.push({ id: 'player_id', name: 'player_id', label: 'معرّف الجهاز / ID', placeholder: 'أدخل معرّف الجهاز بدقة هنا', type: 'text', required: true });
        }
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
      
      const packagesJson = isDynamic ? '[]' : JSON.stringify([{ id: 1, name: "تفعيل فوري تلقائي", price: localPrice, usd_price: localPrice, api_service_id: s.id.toString(), api_service_type: svcType, status: "Available", discount: 0 }]);
      const fieldsJson = JSON.stringify(serviceFields);

      let existingSvc = await getQuery("SELECT id FROM services WHERE api_service_id = ? AND api_provider_id = ?", [s.id.toString(), provider.id]);

      if (!existingSvc) {
        await runQuery(
          "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_provider_id, api_price, min_quantity, max_quantity, api_service_type, api_delivery_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [categoryId, cleanServiceName, `تفعيل خدمة ${cleanServiceName} فوري عبر API`, isDynamic ? 0 : localPrice, 'default', packagesJson, fieldsJson, priceType, pricePerThousand, 'بيانات الخدمة', s.id.toString(), 'api_provider', provider.id, apiPriceUsd, minQty, maxQty, svcType, s.time || '']
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

// Sync Provider (Admin Protected)
router.post('/:id/sync', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { exchange_rate, markup_percent, group_as_packages } = req.body;
  
  // We can still save these generically or update them globally as user prefers
  if (exchange_rate) await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_exchange_rate', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [exchange_rate]);
  if (markup_percent) await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_markup_percent', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [markup_percent]);
  if (group_as_packages !== undefined) await runQuery("INSERT INTO settings (key, value) VALUES ('amrr_group_as_packages', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [group_as_packages ? 'true' : 'false']);

  try {
    const result = await performProviderSync(id, exchange_rate, markup_percent, group_as_packages);
    res.json({
      success: true,
      message: `تمت المزامنة بنجاح. تم إضافة ${result.addedCategoriesCount} قسم و ${result.addedServicesCount} خدمة، وتحديث ${result.updatedServicesCount} خدمة.`,
      categoriesCount: result.addedCategoriesCount,
      servicesCount: result.addedServicesCount + result.updatedServicesCount
    });
  } catch (error) {
    console.error('Provider sync error:', error.message);
    res.status(500).json({ message: `حدث خطأ أثناء المزامنة: ${error.message}` });
  }
});

// Fetch Services from Provider without saving (Admin Protected)
router.post('/:id/fetch-services', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const provider = await getQuery('SELECT * FROM api_providers WHERE id = ?', [id]);
    if (!provider) return res.status(404).json({ message: 'المزود غير موجود.' });

    const [imeiRes, serverRes, remoteRes] = await Promise.all([
      callDhruApi(provider.api_url, provider.username, provider.api_key, 'imeiservicelist').catch(e => ({ ERROR: e.message })),
      callDhruApi(provider.api_url, provider.username, provider.api_key, 'serverservicelist').catch(e => ({ ERROR: e.message })),
      callDhruApi(provider.api_url, provider.username, provider.api_key, 'remoteservicelist').catch(e => ({ ERROR: e.message }))
    ]);

    const services = [
      ...parseDhruServices(imeiRes, 'imei'),
      ...parseDhruServices(serverRes, 'server'),
      ...parseDhruServices(remoteRes, 'remote')
    ];

    if (services.length === 0) {
      return res.status(400).json({ message: 'لم يتم العثور على أي خدمات أو فشل الاتصال بالمزود.' });
    }

    res.json({
      success: true,
      servicesCount: services.length,
      services: services
    });
  } catch (error) {
    console.error('Fetch provider services error:', error.message);
    res.status(500).json({ message: error.message || 'فشل الاتصال بالمزود.' });
  }
});

// Import specific services from Provider (Admin Protected)
router.post('/:id/import-services', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { services, exchange_rate, markup_percent, local_category_id, custom_category_name, group_as_packages } = req.body;

  if (!services || !Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ message: 'يرجى تحديد خدمة واحدة على الأقل للاستيراد.' });
  }

  try {
    const provider = await getQuery('SELECT * FROM api_providers WHERE id = ?', [id]);
    if (!provider) return res.status(404).json({ message: 'المزود غير موجود.' });

    let apiCurrency = provider.currency || 'USD';
    const rate = parseFloat(exchange_rate) || 50;
    const markup = parseFloat(markup_percent) || 0;
    const shouldGroup = group_as_packages !== undefined ? group_as_packages : true;

    let addedCategoriesCount = 0;
    let addedServicesCount = 0;
    let updatedServicesCount = 0;

    if (shouldGroup) {
      const groups = {};
      for (const s of services) {
        let catName = custom_category_name || s.category || 'عام';
        if (local_category_id && local_category_id !== 'auto') {
          const localCat = await getQuery('SELECT name FROM categories WHERE id = ?', [local_category_id]);
          if (localCat) catName = localCat.name;
        }
        if (!groups[catName]) groups[catName] = [];
        groups[catName].push(s);
      }

      for (const [groupName, groupServices] of Object.entries(groups)) {
        const cleanGroupName = groupName;
        const combinedFields = [];
        const addedFieldNames = new Set();
        
        for (const s of groupServices) {
          if (s.customFields && Array.isArray(s.customFields)) {
            for (const cf of s.customFields) {
              const fieldId = `custom_${cf.field_id || cf.fieldname}`;
              const fieldLabel = String(cf.fieldname || '').toLowerCase().trim();
              if (!addedFieldNames.has(fieldId) && !addedFieldNames.has(fieldLabel)) {
                addedFieldNames.add(fieldId);
                addedFieldNames.add(fieldLabel);
                combinedFields.push({
                  id: fieldId,
                  name: fieldId,
                  label: cf.fieldname,
                  placeholder: cf.description || `أدخل ${cf.fieldname}`,
                  type: cf.fieldtype === 'select' ? 'select' : (cf.fieldtype === 'textarea' ? 'textarea' : 'text'),
                  options: cf.fieldoptions ? cf.fieldoptions.split(',').map(o => o.trim()) : [],
                  required: cf.required === 'on'
                });
              }
            }
          }
        }

        if (combinedFields.length === 0) {
          const dominantTypeEarly = Object.entries(
            groupServices.reduce((acc, s) => { const t = s.serviceType || 'imei'; acc[t] = (acc[t] || 0) + 1; return acc; }, {})
          ).sort((a, b) => b[1] - a[1])[0]?.[0] || 'imei';
          if (dominantTypeEarly === 'imei') {
            combinedFields.push({ id: 'imei', name: 'imei', label: 'IMEI / SN / ECID', placeholder: 'أدخل رقم IMEI أو الرقم التسلسلي (SN) أو ECID', type: 'text', required: true });
          } else {
            combinedFields.push({ id: 'player_id', name: 'player_id', label: 'معرّف الجهاز / ID', placeholder: 'أدخل معرّف الجهاز بدقة هنا', type: 'text', required: true });
          }
        }

        let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [cleanGroupName]);
        let categoryId;
        if (!cat) {
          const catInsert = await runQuery(
            "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false) RETURNING id",
            [cleanGroupName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify(combinedFields), 'بيانات الخدمة']
          );
          categoryId = catInsert ? (catInsert.id || catInsert.lastID) : null;
          addedCategoriesCount++;
        } else {
          categoryId = cat.id;
        }

        const mergedPackages = [];
        let multiplier = 1;
        if (apiCurrency === 'EGP') multiplier = 1 / rate;

        groupServices.forEach((s, idx) => {
          let apiPriceUsd = parseFloat(s.price) || 0;
          if (s.custom_price !== null && s.custom_price !== undefined) {
            apiPriceUsd = parseFloat(s.custom_price);
          }
          let localPrice = parseFloat((apiPriceUsd * multiplier * (1 + markup / 100)).toFixed(2));
          let discount = 0;
          if (s.custom_discount !== null && s.custom_discount !== undefined) {
             discount = parseFloat(s.custom_discount);
             localPrice = parseFloat((apiPriceUsd * multiplier * (1 + markup / 100)) - discount).toFixed(2);
          }

          const cleanPkgName = s.name || 'تفعيل فوري تلقائي';
          const isDynamicPkg = (s.max_quantity > 1 && s.max_quantity !== s.min_quantity) || (s.min_quantity > 1 && s.max_quantity === 0) || s.requires_quantity;

          const packageFields = [];
          if (s.customFields && s.customFields.length > 0) {
            s.customFields.forEach(cf => {
              const fieldId = `custom_${cf.field_id || cf.fieldname}`;
              packageFields.push({
                id: fieldId,
                name: fieldId,
                label: cf.fieldname,
                placeholder: cf.description || `أدخل ${cf.fieldname}`,
                type: cf.fieldtype === 'select' ? 'select' : (cf.fieldtype === 'textarea' ? 'textarea' : 'text'),
                options: cf.fieldoptions ? cf.fieldoptions.split(',').map(o => o.trim()) : [],
                required: cf.required === 'on'
              });
            });
          }

          mergedPackages.push({
            id: idx + 1,
            name: cleanPkgName,
            price: parseFloat(localPrice) > 0 ? parseFloat(localPrice) : 0,
            usd_price: parseFloat(localPrice) > 0 ? parseFloat(localPrice) : 0,
            api_service_id: s.id.toString(),
            api_service_type: s.serviceType || 'imei',
            status: "Available",
            discount: discount,
            min_quantity: s.min_quantity || 1,
            max_quantity: s.max_quantity || 0,
            requires_quantity: isDynamicPkg,
            fields: packageFields
          });
        });

        const fieldsJson = JSON.stringify(combinedFields);
        const typeCounts = groupServices.reduce((acc, s) => { const t = s.serviceType || 'imei'; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
        const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'imei';

        let existingSvc = await getQuery("SELECT id FROM services WHERE name = ? AND api_provider_id = ? AND api_service_id = 'grouped'", [cleanGroupName, provider.id]);
        
        if (!existingSvc) {
          const minPrice = mergedPackages.length > 0 ? Math.min(...mergedPackages.map(p => p.price)) : 0;
          await runQuery(
            "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_provider_id, api_price, min_quantity, max_quantity, api_service_type, api_delivery_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [categoryId, cleanGroupName, `باقات وتفعيل خدمات ${cleanGroupName}`, minPrice, 'default', JSON.stringify(mergedPackages), fieldsJson, 'fixed', 0, 'بيانات الخدمة', 'grouped', 'api_provider', provider.id, 0, 1, 0, dominantType, '']
          );
          addedServicesCount++;
        } else {
          const existingSvcRow = await getQuery("SELECT packages FROM services WHERE id = ?", [existingSvc.id]);
          let existingPackages = [];
          try { existingPackages = JSON.parse(existingSvcRow.packages); } catch(e){}

          mergedPackages.forEach(newPkg => {
             const existIdx = existingPackages.findIndex(ep => ep.api_service_id === newPkg.api_service_id);
             if (existIdx > -1) {
               existingPackages[existIdx] = { ...existingPackages[existIdx], ...newPkg, id: existingPackages[existIdx].id };
             } else {
               const nextId = existingPackages.length > 0 ? Math.max(...existingPackages.map(p => p.id)) + 1 : 1;
               existingPackages.push({ ...newPkg, id: nextId });
             }
          });

          const newMinPrice = existingPackages.length > 0 ? Math.min(...existingPackages.map(p => p.price)) : 0;
          await runQuery(
            "UPDATE services SET price = ?, packages = ?, fields = ?, category_id = ?, api_service_type = ?, api_delivery_time = ? WHERE id = ?",
            [newMinPrice, JSON.stringify(existingPackages), fieldsJson, categoryId, dominantType, '', existingSvc.id]
          );
          updatedServicesCount++;
        }
      }
    } else {
      for (const s of services) {
        let cleanCategoryName = custom_category_name || s.category || 'عام';
        if (local_category_id && local_category_id !== 'auto') {
          const localCat = await getQuery('SELECT name FROM categories WHERE id = ?', [local_category_id]);
          if (localCat) cleanCategoryName = localCat.name;
        }

        let cat = await getQuery('SELECT id FROM categories WHERE name = ?', [cleanCategoryName]);
        let categoryId;
        if (!cat) {
          const catInsert = await runQuery(
            "INSERT INTO categories (name, image, color, icon, currency, fields, fields_title, show_in_menu) VALUES (?, ?, ?, ?, ?, ?, ?, false) RETURNING id",
            [cleanCategoryName, 'default', '#0284c7', 'credit-card', 'USD', JSON.stringify([]), 'بيانات الخدمة']
          );
          categoryId = catInsert ? (catInsert.id || catInsert.lastID) : null;
          addedCategoriesCount++;
        } else {
          categoryId = cat.id;
        }

        const serviceFields = [];
        if (s.customFields && Array.isArray(s.customFields)) {
          s.customFields.forEach(cf => {
            const fieldId = `custom_${cf.field_id || cf.fieldname}`;
            serviceFields.push({
              id: fieldId,
              name: fieldId,
              label: cf.fieldname,
              placeholder: cf.description || `أدخل ${cf.fieldname}`,
              type: cf.fieldtype === 'select' ? 'select' : (cf.fieldtype === 'textarea' ? 'textarea' : 'text'),
              options: cf.fieldoptions ? cf.fieldoptions.split(',').map(o => o.trim()) : [],
              required: cf.required === 'on'
            });
          });
        }
        if (serviceFields.length === 0) {
          if ((s.serviceType || 'imei') === 'imei') {
            serviceFields.push({ id: 'imei', name: 'imei', label: 'IMEI / SN / ECID', placeholder: 'أدخل رقم IMEI أو الرقم التسلسلي (SN) أو ECID', type: 'text', required: true });
          } else {
            serviceFields.push({ id: 'player_id', name: 'player_id', label: 'معرّف الجهاز / ID', placeholder: 'أدخل معرّف الجهاز بدقة هنا', type: 'text', required: true });
          }
        }

        let multiplier = 1;
        if (apiCurrency === 'EGP') multiplier = 1 / rate;

        let apiPriceUsd = parseFloat(s.price) || 0;
        if (s.custom_price !== null && s.custom_price !== undefined) {
          apiPriceUsd = parseFloat(s.custom_price);
        }
        
        let localPrice = parseFloat((apiPriceUsd * multiplier * (1 + markup / 100)).toFixed(2));
        let discount = 0;
        if (s.custom_discount !== null && s.custom_discount !== undefined) {
           discount = parseFloat(s.custom_discount);
           localPrice = parseFloat((apiPriceUsd * multiplier * (1 + markup / 100)) - discount).toFixed(2);
        }

        const cleanServiceName = s.name || 'تفعيل فوري تلقائي';
        const svcType = s.serviceType || 'imei';
        const minQty = s.min_quantity || 1;
        const maxQty = s.max_quantity || 0;
        const isDynamic = (maxQty > 1 && maxQty !== minQty) || (minQty > 1 && maxQty === 0) || s.requires_quantity;
        
        const priceType = isDynamic ? 'dynamic' : 'fixed';
        const pricePerThousand = isDynamic ? localPrice * 1000 : 0;
        
        const packagesJson = isDynamic ? '[]' : JSON.stringify([{ id: 1, name: "تفعيل فوري تلقائي", price: localPrice, usd_price: localPrice, api_service_id: s.id.toString(), api_service_type: svcType, status: "Available", discount: discount }]);
        const fieldsJson = JSON.stringify(serviceFields);

        let existingSvc = await getQuery("SELECT id FROM services WHERE api_service_id = ? AND api_provider_id = ?", [s.id.toString(), provider.id]);

        if (!existingSvc) {
          await runQuery(
            "INSERT INTO services (category_id, name, description, price, image, packages, fields, price_type, price_per_thousand, fields_title, api_service_id, api_source, api_provider_id, api_price, min_quantity, max_quantity, api_service_type, api_delivery_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [categoryId, cleanServiceName, `تفعيل خدمة ${cleanServiceName} فوري عبر API`, isDynamic ? 0 : localPrice, 'default', packagesJson, fieldsJson, priceType, pricePerThousand, 'بيانات الخدمة', s.id.toString(), 'api_provider', provider.id, apiPriceUsd, minQty, maxQty, svcType, s.time || '']
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

    res.json({
      success: true,
      message: `تمت الاستيراد بنجاح. تم تعديل/إضافة ${updatedServicesCount + addedServicesCount} خدمة.`
    });
  } catch (error) {
    console.error('Provider import services error:', error.message);
    res.status(500).json({ message: `حدث خطأ أثناء الاستيراد: ${error.message}` });
  }
});

module.exports = router;

