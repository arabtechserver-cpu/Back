function fieldValues(field) {
  return [field?.id, field?.name, field?.api_name, field?.field_id, field?.label]
    .map(value => String(value || '').trim().toLowerCase());
}

function hasProviderSn(field) {
  return fieldValues(field).some(value => value === 'sn' || value === 'custom_sn');
}

function isLegacySerialNumber(field) {
  return fieldValues(field).some(value => value === 'serial number' || value === 'custom_serial number');
}

function removeLegacySerialDuplicate(fields) {
  if (!Array.isArray(fields)) return [];
  if (!fields.some(hasProviderSn)) return fields;
  return fields.filter(field => !isLegacySerialNumber(field));
}

module.exports = { removeLegacySerialDuplicate };
