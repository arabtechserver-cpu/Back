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

// Helper: extract customFields from all possible Dhru Fusion / Omar-server field formats
function extractCustomFields(s) {
  let raw =
    s["Requires.Custom"] ||
    s["REQUIRES.CUSTOM"] ||
    (s.Requires && s.Requires.Custom) ||
    (s.REQUIRES && s.REQUIRES.CUSTOM) ||
    (s.REQUIRES && s.REQUIRES.Custom) ||
    (s.Requires && s.Requires.CUSTOM) ||
    s.RequiresCustom ||
    s.CUSTOMFIELD ||
    s.CUSTOMFIELDS ||
    s.customfields ||
    s.CustomFields ||
    s.FIELDS ||
    s.Fields ||
    s.FIELD ||
    null;

  if (!raw) return [];

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        raw = JSON.parse(trimmed);
      } catch (e) {
      }
    }
  }

  if (Array.isArray(raw)) {
    return raw.filter(f => f && (f.fieldname || f.FIELDNAME || f.name || f.NAME));
  }

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw).map(([key, val]) => ({
      field_id: (val && (val.reqid || val.REQID || val.id || val.ID)) || key,
      fieldname: (val && (val.FIELDNAME || val.fieldname || val.name)) || key,
      fieldtype: (val && (val.FIELDTYPE || val.fieldtype || val.type)) || 'text',
      required: (val && (val.REQUIRED || val.required)) || 'on',
      description: (val && (val.DESCRIPTION || val.description || val.placeholder)) || '',
      fieldoptions: (val && (val.FIELDOPTIONS || val.fieldoptions || val.options)) || ''
    }));
  }

  if (typeof raw === 'string') {
    return raw.split(',').map(n => n.trim()).filter(Boolean).map(n => ({
      fieldname: n,
      fieldtype: 'text',
      required: 'on',
      description: ''
    }));
  }

  return [];
}

// Helper: normalize a single raw custom field object into our standard format
function normalizeCustomField(cf) {
  const name = (cf.fieldname || cf.FIELDNAME || cf.name || cf.NAME || '').trim();
  if (!name) return null;
  return {
    field_id: cf.field_id || cf.reqid || cf.REQID || cf.id || cf.ID || name,
    fieldname: name,
    fieldtype: (cf.fieldtype || cf.FIELDTYPE || cf.type || 'text').toLowerCase(),
    required: cf.required || cf.REQUIRED || 'on',
    description: cf.description || cf.DESCRIPTION || cf.placeholder || '',
    fieldoptions: cf.fieldoptions || cf.FIELDOPTIONS || cf.options || ''
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
      min_quantity: parseInt(s.MIN || s.min || s.QNT_MIN || s.qnt_min || s.MIN_QNT || s.min_qnt || s.QNT || 1) || 1,
      max_quantity: parseInt(s.MAX || s.max || s.QNT_MAX || s.qnt_max || s.MAX_QNT || s.max_qnt || 0) || 0,
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
  parseDhruServices
};
