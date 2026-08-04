/**
 * PayPal REST API Service
 * Uses PayPal v2 Orders API (Sandbox or Live)
 */

const fetch = require('node-fetch');

/**
 * Get PayPal OAuth2 access token
 */
async function getAccessToken() {
  const CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
  const CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
  const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'sandbox').trim();
  const BASE_URL = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || 'Failed to get PayPal access token');
  }
  return data.access_token;
}

/**
 * Create a PayPal Order
 * @param {number} amountUSD - Amount in USD
 * @param {string} returnUrl - URL to redirect after approval
 * @param {string} cancelUrl - URL to redirect if cancelled
 * @returns {{ id, approvalUrl }}
 */
async function createOrder(amountUSD, returnUrl, cancelUrl) {
  const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
  const BASE_URL = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const accessToken = await getAccessToken();

  const res = await fetch(`${BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `wallet-${Date.now()}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: Number(amountUSD).toFixed(2),
          },
          description: 'شحن رصيد المحفظة - Spider Store',
        },
      ],
      application_context: {
        brand_name: 'Spider Store',
        locale: 'ar-EG',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Failed to create PayPal order');
  }

  const approvalLink = data.links?.find((l) => l.rel === 'approve');
  return {
    id: data.id,
    status: data.status,
    approvalUrl: approvalLink?.href || null,
  };
}

/**
 * Capture a PayPal Order (complete the payment)
 * @param {string} orderId - PayPal Order ID (the token from redirect)
 * @returns {object} capture result
 */
async function captureOrder(orderId) {
  const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
  const BASE_URL = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const accessToken = await getAccessToken();

  const res = await fetch(`${BASE_URL}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || 'Failed to capture PayPal order');
  }

  // Extract captured amount
  const captureUnit = data.purchase_units?.[0];
  const capture = captureUnit?.payments?.captures?.[0];

  return {
    orderId: data.id,
    status: data.status,
    captureId: capture?.id,
    amount: capture?.amount?.value,
    currency: capture?.amount?.currency_code,
    payerEmail: data.payer?.email_address,
    payerName: `${data.payer?.name?.given_name || ''} ${data.payer?.name?.surname || ''}`.trim(),
  };
}

/**
 * Get order details by ID
 */
async function getOrder(orderId) {
  const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
  const BASE_URL = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const accessToken = await getAccessToken();

  const res = await fetch(`${BASE_URL}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Failed to get order');
  return data;
}

module.exports = { createOrder, captureOrder, getOrder };
