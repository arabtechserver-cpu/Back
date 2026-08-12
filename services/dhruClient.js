const https = require('https');

// Helper to make API calls to Dhru Fusion Server
function callDhruApi(apiUrl, username, apiKey, action, parameters = {}) {
  return new Promise((resolve, reject) => {
    try {
      let finalUrl = apiUrl.trim();
      if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
        finalUrl = 'https://' + finalUrl;
      }
      if (!finalUrl.endsWith('/api/index.php') && !finalUrl.endsWith('/api/index.php/')) {
        if (finalUrl.endsWith('/api/') || finalUrl.endsWith('/api')) {
          finalUrl = finalUrl.replace(/\/$/, '') + '/index.php';
        } else {
          finalUrl = finalUrl.replace(/\/$/, '') + '/api/index.php';
        }
      }
      const urlObj = new URL(finalUrl);
      const postParams = new URLSearchParams();
      postParams.append('username', (username || '').trim());
      postParams.append('apiaccesskey', (apiKey || '').trim());
      postParams.append('action', action);
      postParams.append('requestformat', 'JSON');

      // Helper for nested flattening to support PARAMETERS and CUSTOMFIELD correctly in Dhru Fusion
      const appendParam = (prefix, val) => {
        if (val === null || val === undefined) return;
        if (typeof val === 'object' && !Array.isArray(val)) {
          for (const [k, v] of Object.entries(val)) {
            appendParam(`${prefix}[${k}]`, v);
          }
        } else if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            appendParam(`${prefix}[${idx}]`, item);
          });
        } else {
          postParams.append(prefix, String(val));
        }
      };

      for (const [key, val] of Object.entries(parameters)) {
        appendParam(`parameters[${key}]`, val);
      }

      const postData = postParams.toString();

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        timeout: 180000
      };

      const client = urlObj.protocol === 'https:' ? https : require('http');
      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode >= 400) {
              reject(new Error(`API responded with status code ${res.statusCode}. Cloudflare or server block may be active.`));
              return;
            }
            const json = JSON.parse(body);
            resolve(json);
          } catch (e) {
            reject(new Error(`Response is not valid JSON. Response starts with: ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Network error connecting to API: ${e.message}`));
      });

      req.setTimeout(180000, () => {
        req.destroy(new Error('API request timed out after 180 seconds.'));
      });

      req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Helper to strip HTML tags from a string
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

// Helper to extract error message from Dhru response
function getDhruErrorMessage(responseData) {
  if (!responseData || !responseData.ERROR) return 'Unknown error';
  if (Array.isArray(responseData.ERROR)) {
    const messages = responseData.ERROR
      .map(item => {
        if (!item) return null;
        const msg = item.MESSAGE || item.message || (typeof item === 'string' ? item : null);
        return msg ? stripHtml(msg) : null;
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join('. ');
    return stripHtml(JSON.stringify(responseData.ERROR));
  }
  if (typeof responseData.ERROR === 'string') return stripHtml(responseData.ERROR);
  if (responseData.ERROR && (responseData.ERROR.MESSAGE || responseData.ERROR.message)) {
    return stripHtml(responseData.ERROR.MESSAGE || responseData.ERROR.message);
  }
  return stripHtml(JSON.stringify(responseData.ERROR));
}

function normalizeFieldType(value) {
  const type = String(value || 'text').trim().toLowerCase();
  if (['select', 'dropdown', 'selectbox', 'choice'].includes(type)) return 'select';
  if (['textarea', 'multiline', 'longtext'].includes(type)) return 'textarea';
  if (['number', 'numeric', 'integer'].includes(type)) return 'number';
  if (type === 'email') return 'email';
  if (['password', 'pass'].includes(type)) return 'password';
  return 'text';
}

function normalizeFieldOptions(value) {
  if (Array.isArray(value)) {
    return value.map(option => String(option ?? '').trim()).filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).map(option => String(option ?? '').trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      return normalizeFieldOptions(JSON.parse(trimmed));
    } catch (e) {
      // Keep the provider's plain text option format as a fallback.
    }
  }
  return trimmed.split(/[,\n|]+/).map(option => option.trim()).filter(Boolean);
}

function isRequiredField(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'on', 'required'].includes(String(value ?? '').trim().toLowerCase());
}

// Helper: extract customFields from all possible Dhru Fusion / Omar-server field formats
function extractCustomFields(service) {
  const s = service || {};
  const nestedRequires = s.Requires || s.REQUIRES || {};
  let raw =
    s['Requires.Custom'] ??
    s['REQUIRES.CUSTOM'] ??
    nestedRequires.Custom ??
    nestedRequires.CUSTOM ??
    nestedRequires.custom ??
    s.CUSTOM ??
    s.Custom ??
    s.custom ??
    s.RequiresCustom ??
    s.CUSTOMFIELD ??
    s.CUSTOMFIELDS ??
    s.customfields ??
    s.CustomFields ??
    s.FIELDS ??
    s.Fields ??
    s.FIELD ??
    null;

  if (raw === null || raw === undefined || raw === '') {
    const fieldKey = Object.keys(s).find(key => {
      const normalized = key.replace(/[._\s-]/g, '').toLowerCase();
      return ['requirescustom', 'customfield', 'customfields', 'fields', 'field'].includes(normalized);
    });
    raw = fieldKey ? s[fieldKey] : null;
  }

  if (raw === null || raw === undefined || raw === '') return [];

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        raw = JSON.parse(trimmed);
      } catch (e) {
        // Keep the comma-separated fallback below.
      }
    }
  }

  if (Array.isArray(raw)) {
    return raw.filter(field => field && typeof field === 'object' && (
      field.fieldname || field.FIELDNAME || field.field_name || field.name || field.NAME || field.customname
    ));
  }

  if (raw && typeof raw === 'object') {
    const looksLikeField = [
      'fieldname', 'FIELDNAME', 'field_name', 'name', 'NAME', 'customname',
      'fieldtype', 'FIELDTYPE', 'required', 'REQUIRED'
    ].some(key => Object.prototype.hasOwnProperty.call(raw, key));

    if (looksLikeField) return [raw];

    return Object.entries(raw).map(([key, value]) => ({
      field_id: (value && (value.reqid || value.REQID || value.field_id || value.id || value.ID)) || key,
      fieldname: (value && (value.FIELDNAME || value.fieldname || value.field_name || value.name || value.NAME)) || key,
      fieldtype: (value && (value.FIELDTYPE || value.fieldtype || value.type)) || 'text',
      required: (value && (value.REQUIRED ?? value.required)) ?? 'on',
      description: (value && (value.DESCRIPTION || value.description || value.placeholder)) || '',
      fieldoptions: (value && (value.FIELDOPTIONS ?? value.fieldoptions ?? value.options)) || ''
    }));
  }

  if (typeof raw === 'string') {
    return raw.split(',').map(name => name.trim()).filter(Boolean).map(name => ({
      fieldname: name,
      fieldtype: 'text',
      required: 'on',
      description: ''
    }));
  }

  return [];
}

// Helper: normalize one provider field and preserve the original API field name.
function normalizeCustomField(cf) {
  const field = cf || {};
  const name = String(field.customname || field.fieldname || field.FIELDNAME || field.field_name || field.name || field.NAME || '').trim();
  if (!name) return null;
  return {
    field_id: String(field.field_id || field.reqid || field.REQID || field.id || field.ID || name).trim(),
    fieldname: name,
    fieldtype: normalizeFieldType(field.fieldtype || field.FIELDTYPE || field.type),
    required: isRequiredField(field.required ?? field.REQUIRED ?? 'on'),
    description: String(field.description || field.DESCRIPTION || field.placeholder || '').trim(),
    fieldoptions: normalizeFieldOptions(field.fieldoptions ?? field.FIELDOPTIONS ?? field.options),
    regexpr: String(field.regexpr || field.REGEXPR || '').trim(),
    adminonly: isRequiredField(field.adminonly ?? field.ADMINONLY)
  };
}

function buildStoredCustomField(cf) {
  const normalized = normalizeCustomField(cf);
  if (!normalized) return null;
  const fieldId = normalized.field_id || normalized.fieldname;
  return {
    id: `custom_${fieldId}`,
    name: `custom_${fieldId}`,
    api_name: normalized.fieldname,
    field_id: fieldId,
    label: normalized.fieldname,
    placeholder: normalized.description || `أدخل ${normalized.fieldname}`,
    type: normalized.fieldtype,
    options: normalized.fieldoptions,
    required: normalized.required,
    regexpr: normalized.regexpr,
    adminonly: normalized.adminonly
  };
}

function parseDhruServices(data, serviceType = 'imei') {
  let rawServices = [];
  if (!data) return [];
  
  const getServicePrice = (s) => {
    return parseFloat(s.PRICE || s.CREDIT || s.Price || s.Credit || s.price || s.credit || 0) || 0;
  };

  const pushService = (s, category) => {
    let requiresImei = serviceType !== 'server';
    const req = s.REQUIRES || s.Requires || s;
    if (req && (req.IMEI === false || req.IMEI === 'false' || req.IMEI === '0' || req['IMEI'] === false || req['IMEI'] === 'false' || req['IMEI'] === '0')) requiresImei = false;
    if (s['REQUIRES.IMEI'] === false || s['REQUIRES.IMEI'] === 'false' || s['REQUIRES.IMEI'] === '0') requiresImei = false;
    
    const sName = String(s.SERVICENAME || '').toLowerCase();
    const cName = String(category || '').toLowerCase();

    if (sName.includes('chatgpt') || sName.includes('premium')) requiresImei = false;

    rawServices.push({
      id: s.SERVICEID,
      name: s.SERVICENAME,
      category: category,
      price: getServicePrice(s),
      time: s.TIME || '',
      customFields: extractCustomFields(s).map(normalizeCustomField).filter(Boolean),
      min_quantity: parseInt(s.MIN || s.min || s.Min || s.QNT_MIN || s.qnt_min || s.Qnt_Min || s.MIN_QNT || s.min_qnt || s.Min_Qnt || s.QNT || s.qnt || s.Qnt || 1) || 1,
      max_quantity: parseInt(s.MAX || s.max || s.Max || s.QNT_MAX || s.qnt_max || s.Qnt_Max || s.MAX_QNT || s.max_qnt || s.Max_Qnt || 0) || 0,
      requires_quantity: s.QNT === "1" || s.QNT === "Y" || s.QNT === 1 || s.qnt === "1" || s.qnt === "Y" || s.qnt === 1,
      requires_imei: requiresImei,
      serviceType: serviceType || 'imei'
    });
  };

  if (data.SUCCESS === true && Array.isArray(data.RESULT)) {
    for (const group of data.RESULT) {
      const categoryName = group.GROUPNAME || 'عام';
      if (Array.isArray(group.SERVICES)) {
        for (const s of group.SERVICES) pushService(s, categoryName);
      }
    }
  } 
  else if (Array.isArray(data.SUCCESS)) {
    const first = data.SUCCESS[0];
    if (first && first.LIST && typeof first.LIST === 'object') {
      for (const catKey of Object.keys(first.LIST)) {
        const catObj = first.LIST[catKey];
        if (Array.isArray(catObj)) {
          for (const s of catObj) pushService(s, catKey);
        } 
        else if (catObj && typeof catObj === 'object') {
          const categoryName = catObj.GROUPNAME || catKey || 'عام';
          const servicesObj = catObj.SERVICES;
          if (Array.isArray(servicesObj)) {
            for (const s of servicesObj) pushService(s, categoryName);
          } else if (servicesObj && typeof servicesObj === 'object') {
            for (const svcKey of Object.keys(servicesObj)) {
              const s = servicesObj[svcKey];
              if (s && s.SERVICEID) pushService(s, categoryName);
            }
          }
        }
      }
    } else {
      for (const s of data.SUCCESS) {
        if (s.SERVICEID) pushService(s, s.GROUPNAME || 'عام');
      }
    }
  }
  return rawServices;
}

module.exports = {
  callDhruApi,
  stripHtml,
  getDhruErrorMessage,
  extractCustomFields,
  normalizeCustomField,
  normalizeFieldType,
  normalizeFieldOptions,
  isRequiredField,
  buildStoredCustomField,
  parseDhruServices
};
