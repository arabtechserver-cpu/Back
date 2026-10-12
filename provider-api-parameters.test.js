const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
process.env.JWT_SECRET = 'isolated-xml-parameter-test-secret-1234567890';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
const build = process.env.BORAI_TEST_BUILD || './dist';
const load = file => require(path.resolve(__dirname, build, file));
const { serializeProviderParameters, parseProviderParameters } = load('utils/provider-api-parameters');
const params = { ID: '123', IMEI: 'A<&>"\' B', CUSTOMFIELD: Buffer.from(JSON.stringify({ 'Lock Code': 'A&B' })).toString('base64'), QNT: '2' };
const xml = serializeProviderParameters(params);
assert.ok(xml.startsWith('<PARAMETERS><ID>123</ID>'));
assert.ok(xml.includes('&amp;'));
assert.deepEqual({ ...parseProviderParameters(xml) }, params);
assert.deepEqual(parseProviderParameters(JSON.stringify(params)), params);
assert.deepEqual(parseProviderParameters(params), params);
assert.equal(parseProviderParameters('<PARAMETERS><ID><![CDATA[A&B]]></ID></PARAMETERS>').ID, 'A&B');
assert.equal(parseProviderParameters('<PARAMETERS><ID>&#65;&#x42;</ID></PARAMETERS>').ID, 'AB');
assert.equal(parseProviderParameters('<PARAMETERS><__proto__>safe</__proto__></PARAMETERS>').__proto__, 'safe');
assert.ok(!serializeProviderParameters({ 'customfield[Email]': 'value', 'Battery Picture Link': 'https://example.com' }).includes('Email'));
for (const invalid of ['[]', 'not-json', '<PARAMETERS><ID><nested>1</nested></ID></PARAMETERS>', '<!DOCTYPE PARAMETERS [<!ENTITY secret SYSTEM "file:///private">]><PARAMETERS><ID>&secret;</ID></PARAMETERS>', '<PARAMETERS><ID>&unknown;</ID></PARAMETERS>', '<PARAMETERS><ID>&#0;</ID></PARAMETERS>', '<PARAMETERS><ID>1</ID></PARAMETERS>junk']) {
  assert.throws(() => parseProviderParameters(invalid));
}
const dns = require('node:dns');
const https = require('node:https');
const originalLookup = dns.lookup;
const originalRequest = https.request;
const requests = [];
let replies = [];
dns.lookup = (host, callback) => callback(null, { address: '8.8.8.8', family: 4 });
https.request = (options, callback) => {
  const req = new EventEmitter();
  let posted = '';
  req.write = data => { posted += data; };
  req.destroy = () => {};
  req.end = () => {
    requests.push(new URLSearchParams(posted));
    const res = new EventEmitter(); res.statusCode = 200;
    callback(res);
    res.emit('data', Buffer.from(JSON.stringify(replies.shift() || { SUCCESS: [{ REFERENCEID: 123 }] })));
    res.emit('end');
  };
  return req;
};
const config = { apiUrl: 'https://synthetic.example/public/api/index.php', username: 'synthetic', apiKey: 'synthetic-key' };
async function main() {
  const dhru = load('utils/dhru-api');
  await dhru.placeImeiOrder('123', '123456789012345', { 'Lock Code': 'A&B' }, config);
  const payload = requests.at(-1);
  const sent = parseProviderParameters(payload.get('parameters'));
  assert.equal(sent.ID, '123');
  assert.equal(sent.IMEI, '123456789012345');
  assert.deepEqual(JSON.parse(Buffer.from(sent.CUSTOMFIELD, 'base64').toString()), { 'Lock Code': 'A&B' });
  assert.equal(payload.has('parameters[ID]'), false, 'PHP form parsing must not overwrite XML with a parameters array');
  await dhru.getImeiOrder('123', { ...config, apiUrl: 'https://synthetic.example/api/v1/provider' });
  assert.equal(requests.at(-1).get('parameters[ID]'), '123', 'Retain compatibility with non-PHP form providers');
  assert.equal(requests.at(-1).has('parameters'), false);
  replies = [{ ERROR: [{ MESSAGE: 'Invalid Action' }] }, { SUCCESS: [{ REFERENCEID: 987 }] }];
  requests.length = 0;
  const fallback = await dhru.placeServerOrder('123', 2, { Email: 'test@example.com' }, '', config);
  assert.equal(fallback.SUCCESS[0].REFERENCEID, 987);
  assert.deepEqual(requests.map(r => r.get('action')), ['placeserverorder', 'placeimeiorder']);
  for (const req of requests) {
    assert.equal(parseProviderParameters(req.get('parameters')).QNT, '2');
    assert.equal(parseProviderParameters(req.get('parameters')).ID, '123');
  }
  const providers = load('routes/providers');
  assert.equal(providers.normalizeApiUrl('https://borai-server.com/public'), 'https://borai-server.com/public/api/index.php');
  await providers.makeProviderApiCall(config.apiUrl, config.username, config.apiKey, 'getimeiorder', { ID: '123' });
  assert.equal(parseProviderParameters(requests.at(-1).get('parameters')).ID, '123');
  const { prisma } = load('utils/prisma');
  prisma.order.findUnique = async ({ where }) => {
    assert.equal(where.id, 'synthetic-order');
    return { id: where.id, userId: 'synthetic-user', status: 'pending' };
  };
  const router = load('routes/externalApi').default;
  const handler = router.stack.find(layer => layer.route?.path === '/').route.stack.at(-1).handle;
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', headers: {}, query: {}, apiUser: { id: 'synthetic-user' }, body: { action: 'getimeiorder', parameters: '<PARAMETERS><ID>synthetic-order</ID></PARAMETERS>' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.SUCCESS[0].REFERENCEID, 'synthetic-order');
  assert.equal(res.body.SUCCESS[0].STATUS, '1');
  await prisma.$disconnect();
  console.log('PASS: XML and JSON parameters, escaping, invalid XML rejection, actual outgoing payloads, action fallback, provider URL, provider tester, and incoming XML status requests; no live network or DB access');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { dns.lookup = originalLookup; https.request = originalRequest; });
