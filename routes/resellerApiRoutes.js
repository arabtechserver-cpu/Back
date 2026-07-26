const express = require('express');
const router = express.Router();
const { getQuery, allQuery, runQuery } = require('../db');

// Middleware to verify API key and IP address
async function verifyApiAccess(req, res, next) {
  try {
    const key = req.body.key || req.query.key;
    const username = req.body.username || req.query.username;

    if (!key || !username) {
      return res.status(401).json({ SUCCESS: false, Error: 'Missing API key or username' });
    }

    const customer = await getQuery('SELECT * FROM customers WHERE username = ? AND api_key = ?', [username, key]);

    if (!customer) {
      return res.status(401).json({ SUCCESS: false, Error: 'Invalid API key or username' });
    }

    if (!customer.api_enabled) {
      return res.status(403).json({ SUCCESS: false, Error: 'API access is disabled for this account' });
    }

    // IP Whitelist Check
    const allowedIpsStr = customer.api_allowed_ips || '[]';
    let allowedIps = [];
    try { allowedIps = JSON.parse(allowedIpsStr); } catch(e){}
    
    if (allowedIps.length > 0) {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      // Strip IPv6 to IPv4 prefix if present (::ffff:)
      const cleanIp = clientIp.replace(/^.*:/, '');
      if (!allowedIps.includes(cleanIp) && !allowedIps.includes(clientIp)) {
        return res.status(403).json({ SUCCESS: false, Error: 'IP address not allowed' });
      }
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

  if (action === 'imeiservicelist') {
    try {
      const services = await allQuery('SELECT * FROM services WHERE show_in_menu = true');
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
          
          let basePrice = Number(s.price || 0);
          let finalPrice = basePrice + (basePrice * (markup / 100)); // Apply markup percentage
          if (s.price_type === 'per_thousand') {
             finalPrice = Number(s.price_per_thousand || 0);
             finalPrice = finalPrice + (finalPrice * (markup / 100));
          }

          serviceGroup.SERVICES.push({
            SERVICEID: s.id,
            SERVICENAME: s.name,
            CREDIT: finalPrice.toFixed(2),
            TIME: '1-24 Hours',
            INFO: s.description || ''
          });
        }

        if (serviceGroup.SERVICES.length > 0) {
          result.push(serviceGroup);
        }
      }

      return sendResponse({ SUCCESS: [{ LIST: result }] });
    } catch (e) {
      return sendError('Database error retrieving services');
    }
  }

  if (action === 'placeimeiorder') {
    try {
      const serviceId = req.body.parameters?.SERVICEID || req.body.SERVICEID;
      const imei = req.body.parameters?.IMEI || req.body.IMEI || '';
      
      if (!serviceId) return sendError('SERVICEID is required');

      const blockedServices = customer.api_blocked_services ? JSON.parse(customer.api_blocked_services) : [];
      if (blockedServices.includes(Number(serviceId))) {
        return sendError('This service is not available for your account');
      }

      const service = await getQuery('SELECT * FROM services WHERE id = ?', [serviceId]);
      if (!service) return sendError('Service not found');

      const markup = Number(customer.api_markup || 0);
      let basePrice = Number(service.price || 0);
      if (service.price_type === 'per_thousand') basePrice = Number(service.price_per_thousand || 0);
      let finalPrice = basePrice + (basePrice * (markup / 100));

      const balanceBefore = Number(customer.balance || 0);
      if (balanceBefore < finalPrice) {
        return sendError('Insufficient balance');
      }

      // Deduct atomically
      const updRes = await runQuery('UPDATE customers SET balance = balance - ? WHERE id = ? AND balance >= ?', [finalPrice, customer.id, finalPrice]);
      if (updRes && updRes.changes === 0 && updRes.rowCount === 0) {
        return sendError('Insufficient balance (Race condition detected)');
      }

      const orderData = {
        customer_id: customer.id,
        customer_username: customer.username,
        service_id: service.id,
        service_name: service.name,
        package_name: 'API Order',
        price: finalPrice,
        status: 'pending',
        payment_method: 'wallet',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        payment_status: 'paid',
        is_api_order: true,
        api_reseller_id: customer.id,
        custom_fields: JSON.stringify({ IMEI: imei })
      };

      const result = await runQuery(
        'INSERT INTO orders (customer_id, service_id, service_name, package_name, package_price, status, payment_method, is_api_order, api_reseller_id, custom_fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [orderData.customer_id, orderData.service_id, orderData.service_name, orderData.package_name, orderData.price, orderData.status, orderData.payment_method, true, customer.id, orderData.custom_fields]
      );

      // Log wallet transaction
      await runQuery(
        'INSERT INTO wallet_transactions (customer_id, customer_username, type, amount, balance_before, balance_after, reference_type, reference_id, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [customer.id, customer.username, 'debit', finalPrice, balanceBefore, balanceBefore - finalPrice, 'order', result.lastID, `API Order - ${service.name}`]
      );

      return sendResponse({ SUCCESS: [{ REFERENCEID: result.lastID }] });

    } catch (e) {
      console.error(e);
      return sendError('Error processing order');
    }
  }

  if (action === 'getimeiorder') {
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
