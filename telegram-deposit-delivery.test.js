const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.JWT_SECRET = 'telegram-deposit-isolated-test-secret-1234567890';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
process.env.TELEGRAM_ADMIN_CHAT_ID = '';
process.env.RESEND_API_KEY = '';
const { buildDepositTelegramLinks, getTelegramAppLink } = require('./dist/utils/telegram-deposit-links');
const receiptPath = '/api/transactions/receipts/receipt_test.png';
const id = '11111111-2222-3333-4444-555555555555';
const callbacks = [{ text: 'موافقة وشحن الرصيد', callback_data: 'approve_tx_' + id }, { text: 'رفض الإيداع', callback_data: 'reject_tx_' + id }];
for (const base of ['http://localhost:3000', 'https://localhost', 'http://127.0.0.1:3000', 'http://127.2.3.4:3000', 'http://[::1]:3000', 'http://192.168.1.10', 'http://10.0.0.5', 'http://172.20.0.1', 'http://backend:5000', 'https://store.local', 'ftp://store.example.com', 'https://name:secret@store.example.com', 'invalid']) {
  assert.deepEqual(buildDepositTelegramLinks(id, receiptPath, { APP_URL: base }), { receiptUrl: null, replyMarkup: { inline_keyboard: [callbacks] } }, base);
}
assert.equal(getTelegramAppLink(receiptPath, {}), null, 'Do not invent a public domain');
const publicLinks = buildDepositTelegramLinks(id, receiptPath, { APP_URL: 'https://store.example.com/' });
assert.equal(publicLinks.receiptUrl, 'https://store.example.com' + receiptPath);
assert.deepEqual(publicLinks.replyMarkup.inline_keyboard[1], callbacks);
assert.equal(getTelegramAppLink(receiptPath, { APP_URL: 'http://localhost:3000', FRONTEND_URL: 'http://localhost:3000, https://store.example.com' }), 'https://store.example.com' + receiptPath);
assert.equal(getTelegramAppLink('https://other.example.com/private', { APP_URL: 'https://store.example.com' }), null);
assert.deepEqual(buildDepositTelegramLinks(id, null, {}).replyMarkup.inline_keyboard, [callbacks]);

async function main() {
  const { prisma } = require('./dist/utils/prisma');
  const axios = require('axios');
  const originalPost = axios.post;
  const originalSetting = prisma.setting.findUnique;
  const originalUser = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'borai-deposit-delivery-test-'));
  process.env.UPLOADS_DIR = temp;
  process.env.APP_URL = 'http://localhost:3000';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  const requests = [];
  const receiptData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxsAAAAASUVORK5CYII=';
  let created;
  const createdRequests = [];
  let existingReferenceStatus = null;
  let recentPending = false;
  let failPhotos = false;
  prisma.setting.findUnique = async () => ({ value: '["test-admin"]' });
  prisma.user.findUnique = async () => ({ fullName: 'Synthetic customer', username: 'test', email: '' });
  prisma.$transaction = async fn => fn({ transaction: {
    findFirst: async ({ where }) => where.refNo
      ? { id: 'existing-request', status: existingReferenceStatus, refNo: 'TEST-ONLY' }
      : recentPending ? { id: 'recent-pending-request', status: 'pending' } : null,
    create: async ({ data }) => {
      created = data;
      const transactionId = createdRequests.length === 0 ? id : 'new-request-' + createdRequests.length;
      const record = { id: transactionId, ...data };
      createdRequests.push(record);
      return record;
    }
  }, user: {
    update: async () => { throw Error('Submitting a receipt must never credit a balance'); }

  } });
  axios.post = async (url, body) => {
    assert.ok(url.endsWith('/sendPhoto') || url.endsWith('/sendDocument') || url.endsWith('/sendMessage'));
    const encoded = body.getBuffer ? body.getBuffer().toString('latin1') : JSON.stringify(body);
    assert.ok(!encoded.includes('localhost'), 'Telegram payload must not contain invalid local receipt links');
    assert.ok(encoded.includes('approve_tx_'));
    assert.ok(encoded.includes('reject_tx_'));
    requests.push({ method: url.split('/').pop(), body: encoded });
    if (failPhotos && url.endsWith('/sendPhoto')) throw { response: { data: { description: 'synthetic unsupported photo' } } };
    return { data: { ok: true, result: { message_id: 1 } } };
  };
  try {
    const router = require('./dist/routes/transactions').default;
    const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack.at(-1).handle;
    const response = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ user: { id: 'synthetic-user', role: 'user' }, body: { amount: 10, method: 'Synthetic test', refNo: 'TEST-ONLY', receiptImage: receiptData } }, response);
    for (let n = 0; n < 5 && requests.length === 0; n++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(created.status, 'pending', 'Receipt delivery must not approve deposits');
    assert.equal(created.userId, 'synthetic-user');
    assert.ok(created.receiptImage.startsWith('/api/transactions/receipts/'));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'sendPhoto');
    assert.ok(requests[0].body.includes('name="photo"'));
    assert.ok(!requests[0].body.includes('name="document"'));
    const receiptFile = path.join(temp, 'receipts', path.basename(created.receiptImage));
    assert.deepEqual(fs.readFileSync(receiptFile), Buffer.from(receiptData.split(',')[1], 'base64'));
    for (const previousStatus of ['pending', 'completed']) {
      existingReferenceStatus = previousStatus;
      const repeated = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
      await handler({ user: { id: 'synthetic-user', role: 'user' }, body: { amount: 50, method: 'Another payment method', refNo: 'TEST-ONLY', receiptImage: receiptData } }, repeated);
      for (let n = 0; n < 5 && requests.length < createdRequests.length; n++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(repeated.statusCode, 200, 'A reference from a ' + previousStatus + ' request may be reused');
      assert.equal(repeated.body.success, true);
      assert.equal(repeated.body.transaction.status, 'pending');
      assert.equal(repeated.body.transaction.refNo, 'TEST-ONLY');
      assert.equal(repeated.body.transaction.amount, 50);
      assert.notEqual(repeated.body.transaction.id, id);
      assert.ok(requests.at(-1).body.includes('approve_tx_' + repeated.body.transaction.id));
    }
    assert.equal(createdRequests.length, 3);
    assert.equal(new Set(createdRequests.map(r => r.id)).size, 3, 'Repeated references create distinct review requests');
    assert.equal(createdRequests[0].amount, 10, 'Earlier deposits are unchanged');
    recentPending = true;
    const throttled = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ user: { id: 'synthetic-user', role: 'user' }, body: { amount: 50, method: 'Synthetic test', refNo: 'TEST-ONLY', receiptImage: receiptData } }, throttled);
    assert.equal(throttled.statusCode, 429, 'The submission cooldown remains active');
    assert.equal(createdRequests.length, 3, 'The cooldown creates no new deposit');
    failPhotos = true; requests.length = 0;
    const { sendTelegramPhotoNotification } = require('./dist/utils/telegramService');
    await sendTelegramPhotoNotification({ imageSource: receiptData, caption: 'Synthetic test', replyMarkup: buildDepositTelegramLinks(id, receiptPath, {}).replyMarkup });
    assert.deepEqual(requests.map(r => r.method), ['sendPhoto', 'sendPhoto', 'sendDocument']);
    console.log('PASS: local/private URLs excluded, public URLs retained, callback buttons preserved, real transaction handler attaches the receipt, photo/document fallback, repeated references accepted with distinct pending IDs, previous deposits unchanged, cooldown retained; no live messages or DB writes');
  } finally {
    axios.post = originalPost; prisma.setting.findUnique = originalSetting; prisma.user.findUnique = originalUser; prisma.$transaction = originalTransaction;
    await prisma.$disconnect();
    const receipts = path.join(temp, 'receipts');
    if (fs.existsSync(receipts)) { for (const file of fs.readdirSync(receipts)) fs.unlinkSync(path.join(receipts, file)); fs.rmdirSync(receipts); }
    fs.rmdirSync(temp);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
