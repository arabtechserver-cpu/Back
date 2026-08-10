const fetch = require('node-fetch');

// Utility to get nested property safely (e.g. "data.services.list")
function getNestedValue(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
}

// Map a custom field from dynamic API to our normalized custom field
function normalizeDynamicCustomField(cf, mapping) {
  const name = getNestedValue(cf, mapping.map_custom_field_name) || '';
  if (!name) return null;
  
  return {
    field_id: getNestedValue(cf, mapping.map_custom_field_id) || name,
    field_name: name,
    type: 'text',
    required: true,
    options: []
  };
}

async function fetchDynamicServices(provider) {
  if (!provider.mapping_rules) throw new Error('إعدادات الربط غير موجودة لهذا المزود.');
  
  let mapping;
  try {
    mapping = JSON.parse(provider.mapping_rules);
  } catch (e) {
    throw new Error('إعدادات الربط غير صالحة (JSON غير صحيح).');
  }

  const endpoint = mapping.sync_endpoint || provider.api_url;
  const method = mapping.sync_method || 'GET';
  
  // Prepare headers and body
  const headers = { 'Content-Type': 'application/json' };
  let body = null;
  let url = endpoint;

  // Process payload / auth
  let payloadStr = mapping.sync_payload || '{}';
  payloadStr = payloadStr.replace(/\{\{api_key\}\}/g, provider.api_key);
  payloadStr = payloadStr.replace(/\{\{username\}\}/g, provider.username);

  let payloadObj = {};
  try { payloadObj = JSON.parse(payloadStr); } catch(e){}

  if (method === 'GET') {
    const params = new URLSearchParams(payloadObj);
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  } else {
    body = JSON.stringify(payloadObj);
  }

  // Inject header auth if needed
  if (mapping.auth_type === 'header_bearer') {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  } else if (mapping.auth_type === 'header_key') {
    headers['x-api-key'] = provider.api_key;
  }

  const response = await fetch(url, { method, headers, body: method === 'POST' ? body : undefined });
  const data = await response.json();

  const servicesArray = getNestedValue(data, mapping.map_array_path);
  if (!Array.isArray(servicesArray)) {
    throw new Error('لم يتم العثور على مصفوفة الخدمات في الرد. تأكد من مسار المصفوفة.');
  }

  return servicesArray.map(s => {
    let customFields = [];
    if (mapping.map_custom_fields_path) {
      const rawCf = getNestedValue(s, mapping.map_custom_fields_path);
      if (Array.isArray(rawCf)) {
        customFields = rawCf.map(cf => normalizeDynamicCustomField(cf, mapping)).filter(Boolean);
      } else if (typeof rawCf === 'object' && rawCf !== null) {
        customFields = [normalizeDynamicCustomField(rawCf, mapping)].filter(Boolean);
      }
    }

    return {
      api_service_id: getNestedValue(s, mapping.map_service_id) || '',
      name: getNestedValue(s, mapping.map_service_name) || 'Unnamed',
      category: getNestedValue(s, mapping.map_service_category) || 'عام',
      price: parseFloat(getNestedValue(s, mapping.map_service_price)) || 0,
      min_quantity: parseInt(getNestedValue(s, mapping.map_service_min)) || 1,
      max_quantity: parseInt(getNestedValue(s, mapping.map_service_max)) || 0,
      requires_quantity: (parseInt(getNestedValue(s, mapping.map_service_max)) || 0) > 1,
      customFields: customFields,
      api_service_type: 'dynamic',
      time: ''
    };
  });
}

async function placeDynamicOrder(provider, service, orderData) {
  let mapping;
  try {
    mapping = JSON.parse(provider.mapping_rules);
  } catch (e) {
    throw new Error('إعدادات الربط غير صالحة.');
  }

  const endpoint = mapping.order_endpoint || provider.api_url;
  const method = mapping.order_method || 'POST';
  
  const headers = { 'Content-Type': 'application/json' };
  
  if (mapping.auth_type === 'header_bearer') {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  } else if (mapping.auth_type === 'header_key') {
    headers['x-api-key'] = provider.api_key;
  }

  let payloadStr = mapping.order_payload || '{}';
  payloadStr = payloadStr.replace(/\{\{api_key\}\}/g, provider.api_key);
  payloadStr = payloadStr.replace(/\{\{username\}\}/g, provider.username);
  payloadStr = payloadStr.replace(/\{\{service_id\}\}/g, service.api_service_id);
  
  // Determine link or custom fields
  // the orderData contains link and custom fields map
  const link = orderData.link || (orderData.customFields && Object.values(orderData.customFields)[0]) || '';
  payloadStr = payloadStr.replace(/\{\{link\}\}/g, link);
  payloadStr = payloadStr.replace(/\{\{quantity\}\}/g, orderData.quantity || 1);

  // Inject any custom field provided dynamically
  if (orderData.customFields) {
    for (const [key, val] of Object.entries(orderData.customFields)) {
      payloadStr = payloadStr.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }
  }

  let payloadObj = {};
  try { payloadObj = JSON.parse(payloadStr); } catch(e){}

  let url = endpoint;
  let body = null;
  if (method === 'GET') {
    const params = new URLSearchParams(payloadObj);
    url += (url.includes('?') ? '&' : '?') + params.toString();
  } else {
    body = JSON.stringify(payloadObj);
  }

  const response = await fetch(url, { method, headers, body: method === 'POST' ? body : undefined });
  const data = await response.json();

  let orderId = getNestedValue(data, mapping.map_order_id) || data.order || data.id || data.order_id || null;
  
  if (!orderId && data.error) {
    throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  }

  return { order_id: orderId, raw: data };
}

module.exports = {
  fetchDynamicServices,
  placeDynamicOrder
};
