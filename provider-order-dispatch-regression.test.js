const assert = require('node:assert/strict');
const path = require('node:path');
process.env.JWT_SECRET = 'isolated-provider-dispatch-test-secret-1234567890';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
process.env.TELEGRAM_ADMIN_CHAT_ID = 'synthetic-admin';
process.env.RESEND_API_KEY = '';
const build = process.env.BORAI_TEST_BUILD || './dist';
const load = file => require(path.resolve(__dirname, build, file));
const { prisma } = load('utils/prisma');
const dhru = load('utils/dhru-api');
const axios = require('axios');
let response = { SUCCESS: [{ REFERENCEID: 12345 }] };
const calls = [];
dhru.placeImeiOrder = async (...args) => { calls.push({ type: 'imei', args }); return response; };
dhru.placeServerOrder = async (...args) => { calls.push({ type: 'server', args }); return response; };
const { sendOrderToProvider, getProviderDispatchResult } = load('utils/provider-order-dispatch');
const config = { apiUrl: 'https://synthetic-provider.example/api/index.php', username: 'test-user', apiKey: 'synthetic-key' };
let service = { id: 'service-db-id', dhruId: 'provider-id::987', providerId: 'provider-id', apiServiceType: 'server', apiProvider: { ...config, isActive: true }, requiresCustom: JSON.stringify([{ id: 'custom_Email', field_id: 'Email' }, { field_id: 'QNT', type: 'quantity' }]) };
const baseOrder = { id: 'synthetic-order', serviceId: 'service-db-id', serviceName: 'Synthetic service', quantity: 2, targetInput: 'custom_Email: test@example.com', status: 'pending', apiOrderId: null, refundedAt: null, notes: JSON.stringify({ customFields: { custom_Email: 'test@example.com' }, events: [] }), user: { email: '' } };
let order;
let failSave = false;
function reset() { order = structuredClone(baseOrder); calls.length = 0; failSave = false; }
prisma.order.findUnique = async () => structuredClone(order);
prisma.order.updateMany = async ({ where, data }) => {
  if (where.id !== order.id || where.status !== order.status || (where.apiOrderId === null && order.apiOrderId !== null)) return { count: 0 };
  Object.assign(order, data); return { count: 1 };
};
prisma.order.update = async ({ data }) => {
  if (failSave && data.status === 'processing') throw Error('synthetic save failure');
  Object.assign(order, data); return structuredClone(order);
};
prisma.dhruService.findFirst = async ({ include }) => { assert.equal(include.apiProvider, true); return service; };
prisma.setting.findUnique = async () => ({ value: '["synthetic-admin"]' });
const messages = [];
axios.post = async (url, body) => {
  assert.ok(url.startsWith('https://api.telegram.org/botsynthetic-token/'), 'No live messages or unrelated requests');
  if (url.endsWith('/sendMessage')) messages.push(body.text);
  return { data: { ok: true, result: { message_id: 1 } } };
};
const router = load('routes/orders').default;
const handler = router.stack.find(layer => layer.route?.path === '/dispatch-provider').route.stack.at(-1).handle;
const telegram = load('utils/telegramService');
const makeResponse = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
const callback = { callback_query: { id: 'synthetic-callback', from: { id: 'synthetic-admin' }, message: { chat: { id: 'synthetic-admin' } }, data: 'send_dhru_synthetic-order' } };
async function main() {
  for (const malformed of [null, {}, 'html response', { SUCCESS: true }, { SUCCESS: [] }, { SUCCESS: [{ MESSAGE: 'Done' }] }, { SUCCESS: [{ REFERENCEID: ' ' }] }, { REFERENCEID: 'SENT' }, { REFERENCEID: {} }, { REFERENCEID: 0 }, { REFERENCEID: -1 }, { REFERENCEID: Infinity }, { REFERENCEID: NaN }]) {
    assert.equal(getProviderDispatchResult(malformed).reference, null);
    assert.equal(getProviderDispatchResult(malformed).unconfirmed, true);
  }
  for (const valid of [{ SUCCESS: [{ REFERENCEID: 12345 }] }, { SUCCESS: { REFERENCEID: 'ref-12345' } }, { REFERENCEID: 'ref-12345' }]) {
    assert.ok(getProviderDispatchResult(valid).reference);
    assert.equal(getProviderDispatchResult(valid).error, null);
  }
  for (const rejected of [{ error: 'Provider rejected request' }, { Error: 'Invalid field' }, { ERROR: [{ MESSAGE: 'Rejected' }] }, { SUCCESS: false, REFERENCEID: 123 }, { SUCCESS: [{ ERROR: 'Insufficient balance' }] }]) {
    assert.equal(getProviderDispatchResult(rejected).reference, null);
    assert.ok(getProviderDispatchResult(rejected).error);
    assert.equal(getProviderDispatchResult(rejected).unconfirmed, false);
  }
  reset();
  await sendOrderToProvider(order, service);
  assert.deepEqual(calls[0], { type: 'server', args: ['987', 2, { Email: 'test@example.com', QNT: '2' }, '', config] });
  service = { ...service, apiServiceType: 'imei' };
  reset(); order.notes = JSON.stringify({ rawImei: '123456789012345', customFields: { custom_Email: 'test@example.com' } });
  await sendOrderToProvider(order, service);
  assert.equal(calls[0].type, 'imei');
  assert.equal(calls[0].args[0], '987');
  assert.equal(calls[0].args[1], '123456789012345');
  assert.deepEqual(calls[0].args[3], config);
  calls.length = 0;
  await sendOrderToProvider({ ...order, targetInput: '123456789012345', notes: JSON.stringify({ customFields: { custom_Email: 'test@example.com' } }) }, service);
  assert.equal(calls[0].args[1], '123456789012345', 'Legacy orders with a plain target must retain it');
  service = { ...service, apiServiceType: 'server' };
  reset();
  await sendOrderToProvider({ ...order, targetInput: 'Instant Order', notes: null }, { ...service, requiresCustom: null });
  assert.equal(calls[0].args[3], '');
  assert.deepEqual(calls[0].args[2], {});
  calls.length = 0;
  await sendOrderToProvider({ ...order, targetInput: 'API-test-user', notes: JSON.stringify({ rawImei: 'API-test-user', apiDetails: { username: 'test-user' } }) }, { ...service, requiresCustom: null });
  assert.equal(calls[0].args[3], '', 'API display labels must not become provider identifiers');
  for (const invalid of [{ ...service, apiProvider: null }, { ...service, apiProvider: { ...config, isActive: false } }, { ...service, apiProvider: { ...config, apiKey: '' } }]) {
    await assert.rejects(() => sendOrderToProvider(order, invalid));
  }
  for (const badResponse of [{ error: 'Synthetic rejection' }, { SUCCESS: true }]) {
    response = badResponse; reset();
    const res = makeResponse();
    await handler({ body: { orderId: order.id } }, res);
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
    assert.equal(order.apiOrderId, null);
    assert.equal(order.status, badResponse.error ? 'pending' : 'dispatching');
    assert.ok(!JSON.parse(order.notes).events.some(e => e.action === 'DISPATCHED_TO_PROVIDER'));
    if (!badResponse.error) {
      await handler({ body: { orderId: order.id } }, makeResponse());
      assert.equal(calls.length, 1, 'Unconfirmed delivery must not be blindly retried');
    }
  }
  response = { SUCCESS: [{ REFERENCEID: 12345 }] }; reset();
  const success = makeResponse();
  await handler({ body: { orderId: order.id } }, success);
  assert.equal(success.body.success, true);
  assert.equal(order.apiOrderId, '12345');
  assert.equal(order.status, 'processing');
  assert.ok(JSON.parse(order.notes).events.some(e => e.action === 'DISPATCHED_TO_PROVIDER'));
  await handler({ body: { orderId: order.id } }, makeResponse());
  assert.equal(calls.length, 1, 'Already delivered orders must not be resubmitted');
  reset(); failSave = true;
  await handler({ body: { orderId: order.id } }, makeResponse());
  assert.equal(order.status, 'dispatching', 'A DB save error after acceptance must not unlock resend');
  for (const reply of [{ SUCCESS: [{ REFERENCEID: 'tg-ref' }] }, { SUCCESS: true }, { error: 'Synthetic rejection' }]) {
    response = reply; reset(); messages.length = 0;
    await telegram.handleIncomingTelegramUpdate(callback);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['987', 2, { Email: 'test@example.com', QNT: '2' }, '', config]);
    if (reply.SUCCESS && Array.isArray(reply.SUCCESS)) {
      assert.equal(order.apiOrderId, 'tg-ref'); assert.equal(order.status, 'processing');
    } else {
      assert.equal(order.apiOrderId, null); assert.notEqual(order.status, 'processing');
      assert.ok(messages.some(m => m.includes('[ERROR]')));
      assert.ok(!messages.some(m => m.includes('tg-ref')));
    }
  }
  console.log('PASS: provider configuration, remote IDs, custom fields, quantity, IMEI, fieldless orders, real dashboard and Telegram handlers, errors, missing references, duplicate prevention, and save failures; no live provider requests, messages, or DB writes');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
