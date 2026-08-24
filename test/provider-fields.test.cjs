const assert = require('node:assert/strict');
const test = require('node:test');

const { buildStoredCustomField, parseDhruServices } = require('../services/dhruClient');

test('keeps only the custom fields returned by the provider', () => {
  const result = parseDhruServices({
    SUCCESS: [{
      LIST: {
        'Honor Frp - Direct Source Services': {
          GROUPNAME: 'Honor Frp - Direct Source Services',
          SERVICES: {
            1: {
              SERVICEID: 1,
              SERVICETYPE: 'IMEI',
              SERVICENAME: 'Honor FRP',
              CUSTOM: { customname: 'SN', custominfo: '' },
              'Requires.Custom': ''
            }
          }
        }
      }
    }]
  }, 'imei');

  assert.deepEqual(result[0].customFields.map((field) => field.fieldname), ['SN']);
});

test('does not infer fields from a service name when the provider returns none', () => {
  const result = parseDhruServices({
    SUCCESS: [{
      LIST: {
        'Provider Group': {
          GROUPNAME: 'Provider Group',
          SERVICES: {
            2: {
              SERVICEID: 2,
              SERVICETYPE: 'SERVER',
              SERVICENAME: 'Username and Password Service',
              'Requires.Custom': ''
            }
          }
        }
      }
    }]
  }, 'server');

  assert.deepEqual(result[0].customFields, []);
});

test('keeps explicitly optional provider fields optional even when required flag is missing', () => {
  const storedField = buildStoredCustomField({
    fieldname: 'Owner Info (Optional)',
    description: 'Optional, but highly recommended for higher success rate.'
  });

  assert.equal(storedField.required, false);
});

test('normalizes provider fields with options into select inputs', () => {
  const storedField = buildStoredCustomField({
    fieldname: 'FMI Status',
    fieldtype: 'text',
    fieldoptions: 'Clean|Lost',
    description: 'Lost not supported!'
  });

  assert.equal(storedField.type, 'select');
  assert.deepEqual(storedField.options, ['Clean', 'Lost']);
});
