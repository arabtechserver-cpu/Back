const { allQuery, runQuery } = require('../db');
const { saveImage } = require('../utils/imageSaver');

function isInlineImage(value) {
  return typeof value === 'string' && value.startsWith('data:image');
}

async function convertSettingImage(settings, key, updates) {
  if (!isInlineImage(settings[key])) return;

  const savedPath = await saveImage(settings[key]);
  if (savedPath && savedPath !== settings[key]) {
    updates.push({ key, value: savedPath });
    console.log(`[settings] ${key} -> ${savedPath}`);
  }
}

async function convertPaymentMethodLogos(settings, updates) {
  if (!settings.payment_methods) return;

  let paymentMethods;
  try {
    paymentMethods = JSON.parse(settings.payment_methods);
  } catch (error) {
    console.warn('[settings] payment_methods is not valid JSON, skipped.');
    return;
  }

  if (!Array.isArray(paymentMethods)) return;

  let changed = false;
  for (const method of paymentMethods) {
    if (!method || typeof method !== 'object') continue;

    if (isInlineImage(method.logo)) {
      const savedPath = await saveImage(method.logo);
      if (savedPath && savedPath !== method.logo) {
        method.logo = savedPath;
        changed = true;
        console.log(`[payment_methods] ${method.name || method.id || 'method'} logo -> ${savedPath}`);
      }
    }

    if (isInlineImage(method.image)) {
      const savedPath = await saveImage(method.image);
      if (savedPath && savedPath !== method.image) {
        method.image = savedPath;
        changed = true;
        console.log(`[payment_methods] ${method.name || method.id || 'method'} image -> ${savedPath}`);
      }
    }
  }

  if (changed) {
    updates.push({ key: 'payment_methods', value: JSON.stringify(paymentMethods) });
  }
}

async function main() {
  const rows = await allQuery('SELECT key, value FROM settings');
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const updates = [];

  await convertSettingImage(settings, 'site_logo', updates);
  await convertSettingImage(settings, 'site_favicon', updates);
  await convertPaymentMethodLogos(settings, updates);

  for (const update of updates) {
    await runQuery('UPDATE settings SET value = ? WHERE key = ?', [update.value, update.key]);
  }

  console.log(`Done. Converted ${updates.length} setting value(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Image conversion failed:', error);
    process.exit(1);
  });
