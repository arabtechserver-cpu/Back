const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const sharp = require('sharp');
process.env.JWT_SECRET = 'security-upload-deposit-isolated-test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.RESEND_API_KEY = '';
const { prisma } = require('./dist/utils/prisma');
const { sanitizeImageDataUrl } = require('./dist/utils/safe-image');
const { quoteCartItem } = require('./dist/routes/cart');
const { getProviderPrice, parseProviderPrice, sellingPrice } = require('./dist/utils/service-price');
after(async () => { await prisma.$disconnect(); });
const dataUrl = buffer => 'data:image/png;base64,' + buffer.toString('base64');
const makeImage = () => sharp({ create: { width: 12, height: 12, channels: 3, background: '#307080' } }).png().toBuffer();
const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });

test('uploads decode real images and remove appended scripts; forged, truncated and oversized raster inputs fail', async () => {
  const png = await makeImage();
  const payload = Buffer.from('<?php echo "malicious-marker"; ?><script>alert(1)</script>');
  const safe = await sanitizeImageDataUrl(dataUrl(Buffer.concat([png, payload])));
  assert.equal((await sharp(safe.buffer).metadata()).format, 'webp');
  assert.equal(safe.buffer.includes(Buffer.from('malicious-marker')), false);
  for (const input of [dataUrl(Buffer.from('<script>alert(1)</script>')), dataUrl(png.subarray(0, 15)),
    'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
    'data:image/png;base64,@@@', dataUrl(png).replace('image/png', 'image/jpeg')]) {
    await assert.rejects(() => sanitizeImageDataUrl(input));
  }
  const bomb = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(() => sanitizeImageDataUrl(dataUrl(bomb)));
});

test('provider prices handle fallback fields, currency labels and decimals without silently discarding a positive price', () => {
  assert.equal(getProviderPrice({ CREDIT: '0', PRICE: '12.50' }), 12.5);
  assert.equal(getProviderPrice({ CREDIT: 'unavailable', price: '$1,234.50' }), 1234.5);
  assert.equal(getProviderPrice({ rate: '0,25 USD' }), 0.25);
  assert.equal(getProviderPrice({ credit: '0,125' }), 0.125);
  assert.equal(getProviderPrice({ credit: '0.0015' }), 0.0015);
  for (const value of ['Infinity', 'NaN', '-5', '12oops', {}, null]) assert.equal(parseProviderPrice(value), null);
  assert.equal(sellingPrice(0.0015, 0), 0.0015);
});

test('cart quotes use live prices and names instead of client supplied prices, with bounds and user discounts', () => {
  const item = { quantity: 2, price: 0.01, serviceName: 'forged name' };
  const service = { name: 'Real service', groupName: 'Server', credit: 10, margin: 2, isActive: true, supportsQty: true, minQty: 1, maxQty: 5 };
  const user = { customDiscount: 10, status: 'active' };
  const quote = quoteCartItem(item, service, user);
  assert.equal(quote.price, 10.8);
  assert.equal(quote.total, 21.6);
  assert.equal(quote.serviceName, 'Real service');
  assert.throws(() => quoteCartItem({ quantity: 6 }, service, user), /INVALID_QUANTITY/);
  assert.throws(() => quoteCartItem({ quantity: 1.5 }, service, user), /INVALID_QUANTITY/);
  assert.throws(() => quoteCartItem({ quantity: 1 }, { ...service, credit: 0, margin: 0 }, user), /PRICE_UNAVAILABLE/);
  assert.throws(() => quoteCartItem({ quantity: 1 }, { ...service, isActive: false }, user), /SERVICE_UNAVAILABLE/);
});

test('real checkout recalculates legacy tampered cart prices within a serializable transaction', async () => {
  const originalTx = prisma.$transaction, originalUser = prisma.user.findUnique;
  const orders = [], ledger = [], debits = [];
  let consumed = false;
  const user = { id: 'buyer', status: 'active', balance: 100, customDiscount: 0 };
  const handler = require('./dist/routes/cart').default.stack.find(layer => layer.route?.path === '/checkout').route.stack.at(-1).handle;
  prisma.user.findUnique = async () => ({ balance: 76 });
  prisma.$transaction = async (fn, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return fn({
      cartItem: { findMany: async ({ where }) => { assert.equal(where.userId, 'buyer'); return consumed ? [] : [{ id: 'item-1', serviceId: 'real-service', serviceName: 'forged name', quantity: 2, price: 0.01 }]; }, deleteMany: async () => { consumed = true; } },
      user: { findUnique: async () => user, updateMany: async ({ data }) => { debits.push(data.balance.decrement); return { count: 1 }; } },
      dhruService: { findMany: async () => [{ id: 'real-service', name: 'Real name', groupName: 'Server', credit: 10, margin: 2, isActive: true, supportsQty: true, minQty: 1, maxQty: 5 }] },
      order: { create: async ({ data }) => { orders.push(data); return { id: 'order-1' }; } },
      transaction: { create: async ({ data }) => { ledger.push(data); } }
    });
  };
  try {
    let res = response();
    await handler({ user: { id: 'buyer' }, body: { userId: 'another-user', amount: 0.01 } }, res);
    assert.equal(res.statusCode, 200); assert.deepEqual(debits, [24]);
    assert.equal(orders[0].price, 24); assert.equal(orders[0].serviceName, 'Real name');
    assert.equal(ledger[0].amount, 24);
    res = response(); await handler({ user: { id: 'buyer' }, body: {} }, res);
    assert.equal(res.statusCode, 400); assert.equal(orders.length, 1);
  } finally { prisma.$transaction = originalTx; prisma.user.findUnique = originalUser; }
});

test('receipt migration is additive and can run twice without changing old transactions', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = await PGlite.create();
  try {
    await pg.exec('CREATE TABLE "Transaction" (id TEXT PRIMARY KEY, amount FLOAT); INSERT INTO "Transaction" VALUES (\'existing\', 12.5);');
    const sql = fs.readFileSync(path.join(__dirname, 'prisma/migrations/20261023000000_receipt_fingerprint/migration.sql'), 'utf8');
    await pg.exec(sql); await pg.exec(sql);
    assert.deepEqual((await pg.query('SELECT * FROM "Transaction"')).rows, [{ id: 'existing', amount: 12.5, receiptHash: null }]);
  } finally { await pg.close(); }
});

test('retired newsletter endpoints cannot subscribe or broadcast, including background callers', async () => {
  const { default: router, broadcastNewItemToSubscribers } = require('./dist/routes/newsletter');
  const res = response(); router.stack[0].handle({}, res, () => { throw Error('Retired route must stop here'); });
  assert.equal(res.statusCode, 410);
  assert.deepEqual(await broadcastNewItemToSubscribers({ title: 'old content', message: 'must not send' }), { count: 0, disabled: true });
});

test('AI complaint notifications require login, escape customer content and enforce a cooldown', async () => {
  const telegram = require('./dist/utils/telegramService');
  const originalSend = telegram.sendTelegramPhotoNotification, originalUser = prisma.user.findUnique;
  const sent = [];
  telegram.sendTelegramPhotoNotification = async options => { sent.push(options); };
  prisma.user.findUnique = async () => ({ fullName: '<fake-admin>', email: 'test@example.com' });
  const { executeToolCall } = require('./dist/routes/ai');
  const tool = { function: { name: 'submit_complaint', arguments: JSON.stringify({ subject: '<a href="https://evil.example">fake</a>', details: '<script>evil</script>' }) } };
  try {
    assert.ok((await executeToolCall(tool)).error); assert.equal(sent.length, 0);
    assert.equal((await executeToolCall(tool, 'complaint-test-buyer')).success, true);
    assert.equal(sent.length, 1); assert.ok(!sent[0].caption.includes('<script>'));
    assert.ok(sent[0].caption.includes('&lt;script&gt;')); assert.ok(sent[0].caption.includes('&lt;fake-admin&gt;'));
    assert.ok((await executeToolCall(tool, 'complaint-test-buyer')).error); assert.equal(sent.length, 1);
  } finally { telegram.sendTelegramPhotoNotification = originalSend; prisma.user.findUnique = originalUser; }
});

test('deposit rejects fake images, invalid amounts and duplicate receipts without leaving files; valid deposits remain pending', async () => {
  const telegram = require('./dist/utils/telegramService');
  const originalSend = telegram.sendTelegramPhotoNotification;
  const originalUser = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'borai-upload-security-'));
  const originalDir = process.env.UPLOADS_DIR;
  process.env.UPLOADS_DIR = temp;
  let duplicate = false, pending = 0, fail = false, created = [], sent = [];
  prisma.user.findUnique = async () => ({ fullName: 'Test', username: 'test', email: '' });
  telegram.sendTelegramPhotoNotification = async options => { sent.push(options); };
  prisma.$transaction = async fn => fn({ transaction: {
    findFirst: async ({ where }) => where.OR && duplicate ? { id: 'duplicate' } : null,
    count: async () => pending,
    create: async ({ data }) => { if (fail) throw Error('test storage failure'); created.push(data); return { id: 'test-deposit', ...data }; }
  } });
  const handler = require('./dist/routes/transactions').default.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack.at(-1).handle;
  const receiptImage = dataUrl(await makeImage());
  const submit = async overrides => { const res = response(); await handler({ user: { id: 'test-user' }, body: { amount: 12, method: 'Test bank', refNo: 'Test-123', receiptImage, ...overrides } }, res); return res; };
  try {
    assert.equal((await submit({ receiptImage: dataUrl(Buffer.from('<script>evil</script>')) })).statusCode, 400);
    for (const amount of ['Infinity', '12garbage', -10, 0, 100001, 0.001, {}]) assert.equal((await submit({ amount })).statusCode, 400);
    duplicate = true;
    assert.equal((await submit({})).statusCode, 409);
    assert.equal(fs.readdirSync(temp).length, 0);
    duplicate = false; pending = 3;
    assert.equal((await submit({})).statusCode, 429);
    pending = 0; fail = true;
    assert.equal((await submit({})).statusCode, 500);
    assert.equal(fs.readdirSync(path.join(temp, 'receipts')).length, 0, 'failed transactions clean up their receipt file');
    fail = false;
    const res = await submit({ type: 'completed' });
    assert.equal(res.statusCode, 200);
    assert.equal(created.length, 1);
    assert.equal(created[0].status, 'pending');
    assert.equal(created[0].type, 'شحن محفظة');
    assert.match(created[0].receiptHash, /^[a-f0-9]{64}$/);
    assert.equal(sent.length, 1);
    assert.match(sent[0].imageSource, /^data:image\/webp;base64,/);
  } finally {
    telegram.sendTelegramPhotoNotification = originalSend;
    prisma.user.findUnique = originalUser; prisma.$transaction = originalTransaction;
    if (originalDir === undefined) delete process.env.UPLOADS_DIR; else process.env.UPLOADS_DIR = originalDir;
    // Only known files in this test-created directory are removed.
    const receipts = path.join(temp, 'receipts');
    if (fs.existsSync(receipts)) { for (const filename of fs.readdirSync(receipts)) fs.unlinkSync(path.join(receipts, filename)); fs.rmdirSync(receipts); }
    fs.rmdirSync(temp);
  }
});

test('browser mutation policy rejects unrelated origins, spoofed tunnel domains and originless cookie changes', () => {
  const { protectBrowserMutation, isAllowedOrigin } = require('./dist/middleware/requestSecurity');
  assert.equal(isAllowedOrigin('https://borai.store.evil.example'), false);
  assert.equal(isAllowedOrigin('https://evilngrok.example'), false);
  for (const headers of [{ origin: 'https://evil.example' }, { cookie: 'admin_token=test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const res = response(); let passed = false;
    protectBrowserMutation({ method: 'POST', headers, get(name) { return headers[name]; } }, res, () => { passed = true; });
    assert.equal(passed, false); assert.equal(res.statusCode, 403);
  }
});

test('registration validation and limits reject markup before creating users or notifying Telegram', async () => {
  const originalFind = prisma.user.findUnique;
  let queries = 0;
  prisma.user.findUnique = async () => { queries++; throw Error('Validation should happen before database access'); };
  const app = express(); app.use(express.json()); app.use('/auth', require('./dist/routes/auth').default);
  const server = await new Promise(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  try {
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: '<a href="https://evil.example">fake admin</a>', username: 'test', email: 'test@example.com', password: 'test-password' }) });
      assert.equal(res.status, i < 5 ? 200 : 429);
      const data = await res.json(); assert.equal(data.success, false);
    }
    assert.equal(queries, 0);
  } finally { prisma.user.findUnique = originalFind; await new Promise(resolve => server.close(resolve)); }
});
