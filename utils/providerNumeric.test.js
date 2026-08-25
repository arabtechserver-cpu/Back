const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DB_NUMERIC_MAX,
  normalizeDbMoney,
  normalizeQuantity,
} = require('./providerNumeric');

test('normalizeDbMoney rounds valid values to 2 decimals', () => {
  assert.equal(normalizeDbMoney(12.3456, { fieldName: 'price' }).value, 12.35);
});

test('normalizeDbMoney clamps oversized values to database-safe maximum', () => {
  const result = normalizeDbMoney('99999999999999', { fieldName: 'price' });
  assert.equal(result.value, DB_NUMERIC_MAX);
  assert.equal(result.clamped, true);
});

test('normalizeDbMoney falls back to zero for invalid numeric input', () => {
  const result = normalizeDbMoney('not-a-number', { fieldName: 'price' });
  assert.equal(result.value, 0);
  assert.equal(result.invalid, true);
});

test('normalizeQuantity keeps only non-negative integers', () => {
  assert.equal(normalizeQuantity('25.8', 1), 25);
  assert.equal(normalizeQuantity('-5', 1), 1);
  assert.equal(normalizeQuantity('bad', 7), 7);
});
