const assert = require('node:assert/strict');
const test = require('node:test');

const { removeLegacySerialDuplicate } = require('../services/providerFieldCleanup');

test('removes only the legacy Serial Number duplicate when provider SN exists', () => {
  const fields = [
    { id: 'imei', name: 'imei', label: 'IMEI' },
    { id: 'custom_Serial Number', name: 'Serial Number', label: 'Serial Number' },
    { id: 'custom_SN', name: 'SN', api_name: 'SN', label: 'SN' }
  ];

  assert.deepEqual(removeLegacySerialDuplicate(fields), [fields[0], fields[2]]);
});

test('does not remove a real Serial Number field when there is no SN duplicate', () => {
  const fields = [{ id: 'custom_Serial Number', name: 'Serial Number', label: 'Serial Number' }];

  assert.deepEqual(removeLegacySerialDuplicate(fields), fields);
});
