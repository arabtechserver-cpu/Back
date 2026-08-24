const express = require('express');
const router = express.Router();
const { getQuery, allQuery, runQuery } = require('../db');
const telegram = require('../utils/telegramService');

// Middleware to verify API key and IP address
async function verifyApiAccess(req, res, next) {
  try {
    const key = req.body.key || req.query.key;
    const username = String(req.body.username || req.query.username || '').trim();

    if (!key) {
      return res.status(401).json({ SUCCESS: false, Error: 'Missing API key' });
    }
    if (!username) {
      return res.status(401).json({ SUCCESS: false, Error: 'Registered username is required' });
    }

    const customer = await getQuery('SELECT * FROM customers WHERE username = ? AND api_key = ?', [username, key]);

    if (!customer) {
      return res.status(401).json({ SUCCESS: false, Error: 'Invalid API key' });
    }

    if (!customer.api_enabled) {
      return res.status(403).json({ SUCCESS: false, Error: 'API access is disabled for this account' });
    }

    // IP Whitelist Check
    const allowedIpsStr = customer.api_allowed_ips || '[]';
    let allowedIps = [];
    try { allowedIps = JSON.parse(allowedIpsStr); } catch(e){}
    
    if (allowedIps.length === 0) {
      return res.status(403).json({ SUCCESS: false, Error: 'Add your server IP to the whitelist before using the API' });
    }
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const clientIp = forwarded || req.socket.remoteAddress || '';
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    const normalizedAllowed = allowedIps.map(ip => String(ip).trim().replace(/^::ffff:/, ''));
    if (!normalizedAllowed.includes(cleanIp) && !normalizedAllowed.includes(clientIp)) {
      return res.status(403).json({ SUCCESS: false, Error: `IP address not allowed: ${cleanIp}` });
    }

    req.apiCustomer = customer;
    next();
  } catch (error) {
    console.error('API Verify Error:', error);
    res.status(500).json({ SUCCESS: false, Error: 'Internal Server Error' });
  }
}

// Helper to log API requests
async function logApiRequest(customer_id, api_key, endpoint, req_body, res_status, ip_address) {
  try {
    await runQuery(
      'INSERT INTO api_logs (customer_id, api_key, endpoint, request_body, response_status, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [customer_id, api_key, endpoint, JSON.stringify(req_body), res_status, ip_address]
    );
  } catch (e) {
    console.error('Failed to log API request:', e);
  }
}

// Dhru Fusion Standard API Route
router.post('/', verifyApiAccess, async (req, res) => {
  const action = req.body.action || req.query.action;
  const customer = req.apiCustomer;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const sendResponse = (data) => {
    logApiRequest(customer.id, customer.api_key, action || 'unknown', req.body, 200, clientIp);
    return res.json(data);
  };
  const sendError = (errorMsg) => {
    logApiRequest(customer.id, customer.api_key, action || 'unknown', req.body, 400, clientIp);
    return res.json({ SUCCESS: false, Error: errorMsg });
  };

  if (!action) return sendError('Missing action parameter');

  if (action === 'accountinfo') {
    return sendResponse({
      SUCCESS: [{
        AccountInfo: {
          credit: String(customer.balance || 0),
          currency: 'USD'
        }
      }]
    });
  }

  const targetTypeMap = {
    'imeiservicelist': 'imei',
    'serverservicelist': 'server',
    'remoteservicelist': 'remote'
  };

  if (targetTypeMap[action]) {
    const targetType = targetTypeMap[action];
    try {
      const services = await allQuery('SELECT * FROM services');
      const categories = await allQuery('SELECT * FROM categories');
      
      const blockedServices = customer.api_blocked_services ? JSON.parse(customer.api_blocked_services) : [];
      const markup = Number(customer.api_markup || 0);

      const result = [];
      for (const cat of categories) {
        const catServices = services.filter(s => Number(s.category_id) === Number(cat.id));
        if (catServices.length === 0) continue;

        const serviceGroup = {
          GROUPNAME: cat.name,
          SERVICES: []
        };

        for (const s of catServices) {
          if (blockedServices.includes(s.id)) continue;
          
          const svcType = s.api_service_type || 'imei';
          if (svcType !== targetType) continue;

          let packages = [];
          try {
             if (s.packages) packages = JSON.parse(s.packages);
          } catch(e) {}
          
          if (packages && packages.length > 0) {
             for (const pkg of packages) {
                let pkgPrice = Number(pkg.price || 0);
                pkgPrice = pkgPrice + (pkgPrice * (markup / 100));

                let requiresCustom = undefined;
                let activeFields = pkg.fields && pkg.fields.length > 0 ? pkg.fields : null;
                if (!activeFields) {
                   try {
                      if (s.fields) activeFields = JSON.parse(s.fields);
                   } catch(e) {}
                }

                if (activeFields && activeFields.length > 0) {
                   requiresCustom = {};
                   activeFields.forEach((f, idx) => {
                      const fId = f.field_id || String(idx + 1);
                      requiresCustom[fId] = {
                         reqid: fId,
                         fieldname: (f.fieldname || f.name || 'Field').replace(/^أدخل\s*/, '').replace(/\.\.\.$/, '').trim(),
                         fieldtype: f.fieldtype || 'text',
                         required: f.required ? "1" : "0",
                         description: f.description || "",
                         fieldoptions: f.fieldoptions || ""
                      };
                   });
                }

                // Generate composite ID: s.id * 100000 + pkg.id
                const compositeId = (Math.floor(s.id) * 100000) + Math.floor(pkg.id);

                serviceGroup.SERVICES.push({
                   SERVICEID: compositeId,
                   SERVICENAME: pkg.name || s.name,
                   CREDIT: pkgPrice.toFixed(2),
                   TIME: s.api_delivery_time || '1-24 Hours',
                   INFO: s.description || '',
                   "Requires.Custom": requiresCustom
                });
             }
          } else {
            let basePrice = Number(s.price || 0);
            let finalPrice = basePrice + (basePrice * (markup / 100)); 
            if (s.price_type === 'per_thousand') {
               finalPrice = Number(s.price_per_thousand || 0);
               finalPrice = finalPrice + (finalPrice * (markup / 100));
            }
  
            let requiresCustom = undefined;
            let fields = [];
            try {
               if (s.fields) fields = JSON.parse(s.fields);
            } catch(e) {}
  
            if (fields && fields.length > 0) {
               requiresCustom = {};
               fields.forEach((f, idx) => {
                  const fId = f.field_id || String(idx + 1);
                  requiresCustom[fId] = {
                     reqid: fId,
                     fieldname: (f.fieldname || f.name || 'Field').replace(/^أدخل\s*/, '').replace(/\.\.\.$/, '').trim(),
                     fieldtype: f.fieldtype || 'text',
                     required: f.required ? "1" : "0",
                     description: f.description || "",
                     fieldoptions: f.fieldoptions || ""
                  };
               });
            }
  
            serviceGroup.SERVICES.push({
              SERVICEID: s.id,
              SERVICENAME: s.name,
              CREDIT: finalPrice.toFixed(2),
              TIME: s.api_delivery_time || '1-24 Hours',
              INFO: s.description || '',
              "Requires.Custom": requiresCustom
            });
          }
        }

        if (serviceGroup.SERVICES.length > 0) {
          result.push(serviceGroup);
        }
      }

      return sendResponse({ SUCCESS: [{ LIST: result }] });
    } catch (e) {
      console.error(e);
      return sendError('Database error retrieving services');
    }
  }

  const placeOrderActions = ['placeimeiorder', 'placeserverorder', 'placeremoteorder'];
  if (placeOrderActions.includes(action)) {
    try {
      let inputServiceId = Number(req.body.parameters?.SERVICEID || req.body.SERVICEID);
      const imei = req.body.parameters?.IMEI || req.body.IMEI || '';
      
      if (!inputServiceId) return sendError('SERVICEID is required');

      let dbServiceId = inputServiceId;
      let dbPackageId = null;
      if (inputServiceId > 100000) {
         dbPackageId = inputServiceId % 100000;
         dbServiceId = Math.floor(inputServiceId / 100000);
      }

      const blockedServices = customer.api_blocked_services ? JSON.parse(customer.api_blocked_services) : [];
      if (blockedServices.includes(dbServiceId)) {
        return sendError('This service is not available for your account');
      }

      const service = await getQuery('SELECT * FROM services WHERE id = ?', [dbServiceId]);
      if (!service) return sendError('Service not found');

      let targetPkg = null;
      if (dbPackageId) {
         try {
            const pkgs = JSON.parse(service.packages || '[]');
            targetPkg = pkgs.find(p => Number(p.id) === dbPackageId);
         } catch(e) {}
         if (!targetPkg) return sendError('Package not found inside service');
      }

      const markup = Number(customer.api_markup || 0);
      let basePrice = targetPkg ? Number(targetPkg.price || 0) : Number(service.price || 0);
      if (!targetPkg && service.price_type === 'per_thousand') basePrice = Number(service.price_per_thousand || 0);
      let finalPrice = basePrice + (basePrice * (markup / 100));

      const balanceBefore = Number(customer.balance || 0);
      const isPostpaid = customer.api_payment_mode === 'postpaid';
      
      if (!isPostpaid) {
        if (balanceBefore < finalPrice) {
          return sendError('Insufficient balance');
        }

        // Deduct atomically
        const updRes = await runQuery('UPDATE customers SET balance = balance - ? WHERE id = ? AND balance >= ?', [finalPrice, customer.id, finalPrice]);
        if (updRes && updRes.changes === 0 && updRes.rowCount === 0) {
          return sendError('Insufficient balance (Race condition detected)');
        }
      }

      let extractedFields = {};
      if (imei) extractedFields.IMEI = imei;
      
      let qnty = 1;
      if (req.body.parameters && req.body.parameters.QNT) {
          qnty = Number(req.body.parameters.QNT);
      } else if (req.body.QNT) {
          qnty = Number(req.body.QNT);
      }
      if (isNaN(qnty) || qnty < 1) qnty = 1;

      if (req.body.parameters && typeof req.body.parameters === 'object') {
         if (req.body.parameters.CUSTOMFIELD) {
             try {
                 const decoded = Buffer.from(req.body.parameters.CUSTOMFIELD, 'base64').toString('utf8');
                 const customFieldsJson = JSON.parse(decoded);
                 Object.assign(extractedFields, customFieldsJson);
             } catch(e) {
                 console.warn("Failed to decode CUSTOMFIELD from reseller API:", e.message);
             }
         }
         Object.keys(req.body.parameters).forEach(k => {
            if (k !== 'SERVICEID' && k !== 'IMEI' && k !== 'QNT' && k !== 'CUSTOMFIELD') {
               extractedFields[k] = req.body.parameters[k];
            }
         });
      } else {
         if (req.body.CUSTOMFIELD) {
             try {
                 const decoded = Buffer.from(req.body.CUSTOMFIELD, 'base64').toString('utf8');
                 const customFieldsJson = JSON.parse(decoded);
                 Object.assign(extractedFields, customFieldsJson);
             } catch(e) {
                 console.warn("Failed to decode CUSTOMFIELD from reseller API (root body):", e.message);
             }
         }
         Object.keys(req.body).forEach(k => {
            if (k !== 'SERVICEID' && k !== 'IMEI' && k !== 'QNT' && k !== 'CUSTOMFIELD' && k !== 'action' && k !== 'username' && k !== 'apiaccesskey' && k !== 'requestformat') {
               extractedFields[k] = req.body[k];
            }
         });
      }

      const orderData = {
        customer_id: customer.id,
        customer_username: customer.username,
        service_id: service.id,
        service_name: service.name,
        package_name: targetPkg ? targetPkg.name : 'API Order',
        price: finalPrice,
        status: 'pending',
        payment_method: 'wallet',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payment_status: 'paid',
        is_api_order: true,
        api_reseller_id: customer.id,
        custom_fields: JSON.stringify(extractedFields),
        player_id: imei,
        api_source: service.api_source || '',
        api_service_id: service.api_service_id || '',
        quantity: qnty
      };

      const result = await runQuery(
        'INSERT INTO orders (customer_id, service_id, service_name, package_name, package_price, status, payment_method, is_api_order, api_reseller_id, custom_fields, player_id, api_source, api_service_id, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [orderData.customer_id, orderData.service_id, orderData.service_name, orderData.package_name, orderData.price, orderData.status, orderData.payment_method, true, customer.id, orderData.custom_fields, orderData.player_id, orderData.api_source, orderData.api_service_id, orderData.quantity]
      );

      // Log wallet transaction only if prepaid
      if (!isPostpaid) {
        await runQuery(
          'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [customer.id, customer.username, 'debit', finalPrice, balanceBefore, balanceBefore - finalPrice, 'order', result.lastID, `API Order - ${service.name}`]
        );
      }

      // Send Telegram notification to admin
      ;(async () => {
        try {
          const adminChatIds = await telegram.getAdminChatIds();
          if (adminChatIds.length > 0) {
            const payLabel = isPostpaid ? 'آجل (يحتاج موافقة)' : 'خصم من المحفظة (API)';
            const tgMsg = [
              `🛒 *طلب API جديد #${result.lastID}*`,
              `🎮 الخدمة: *${service.name}*`,
              `📦 الباقة: *${targetPkg ? targetPkg.name : 'API Order'}* — *${finalPrice}*`,
              imei ? `📱 IMEI: \`${imei}\`` : null,
              `👤 موزع API: *${customer.username}*`,
              `💳 نظام الدفع: ${payLabel}`,
              `\n🔗 راجع الطلب ووافق عليه من لوحة التحكم`
            ].filter(Boolean).join('\n');
            
            for (const chatId of adminChatIds) {
              let keyboard = null;
              if (orderData.api_service_id || orderData.api_source) {
                keyboard = {
                  inline_keyboard: [
                    [{ text: 'موافقة وإرسال للمزود', callback_data: `approve_api_${result.lastID}` }]
                  ]
                };
              }
              await telegram.sendMessage(String(chatId), tgMsg, keyboard).catch(() => {});
            }
          }
        } catch (notifyErr) {
          console.warn('[Admin Notify] Failed to send admin API notification:', notifyErr.message);
        }
      })();

      return sendResponse({ SUCCESS: [{ REFERENCEID: result.lastID }] });

    } catch (e) {
      console.error(e);
      return sendError('Error processing order');
    }
  }

  if (action === 'getimeiorder' || action === 'getserverorder') {
    try {
      const orderId = req.body.parameters?.ID || req.body.ID;
      if (!orderId) return sendError('ID is required');

      const order = await getQuery('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, customer.id]);
      if (!order) return sendError('Order not found');

      // Map local status to Dhru statuses (0=Pending, 1=In Process, 2=Rejected, 3=Success, 4=Success/Completed)
      let dhruStatus = 0;
      if (order.status === 'processing') dhruStatus = 1;
      else if (order.status === 'completed') dhruStatus = 4;
      else if (order.status === 'cancelled' || order.status === 'refunded') dhruStatus = 2;

      return sendResponse({
        SUCCESS: [{
          STATUS: dhruStatus,
          CODE: order.code || order.reply || '',
          MSG: order.reply || ''
        }]
      });
    } catch (e) {
      return sendError('Database error retrieving order');
    }
  }

  return sendError('Invalid action');
});

module.exports = router;
