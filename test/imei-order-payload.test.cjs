const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'unlockerRoutes.js'),
  'utf8'
);

test('imei orders are sent to providers through the primary IMEI payload field', () => {
  assert.match(source, /const imeiPayload = \{/);
  assert.match(source, /IMEI: fallbackImei/);
  assert.match(source, /callDhruApi\(apiUrl, apiUser, apiKey, 'placeimeiorder', imeiPayload\)/);
});
