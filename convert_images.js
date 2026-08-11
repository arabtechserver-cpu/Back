const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { runQuery, allQuery } = require('./db');

const UPLOADS_DIR = path.join(__dirname, 'uploads');

async function convertImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
    const filenameWithoutExt = path.basename(filePath, ext);
    const dir = path.dirname(filePath);
    const newFileName = `${filenameWithoutExt}.webp`;
    const newFilePath = path.join(dir, newFileName);

    try {
      if (fs.existsSync(newFilePath)) {
        console.log(`[Skip] Already exists: ${newFileName}`);
        return newFileName;
      }

      await sharp(filePath)
        .webp({ quality: 80, effort: 4 })
        .toFile(newFilePath);
      
      console.log(`[Success] Converted ${path.basename(filePath)} to ${newFileName}`);
      return newFileName;
    } catch (err) {
      console.error(`[Error] Failed to convert ${filePath}:`, err.message);
      return null;
    }
  }
  return null;
}

async function scanAndConvert(dir) {
  let mappings = {};
  if (!fs.existsSync(dir)) return mappings;

  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const subMappings = await scanAndConvert(fullPath);
      mappings = { ...mappings, ...subMappings };
    } else {
      const newName = await convertImage(fullPath);
      if (newName) {
        // e.g. /uploads/img_123.jpg -> /uploads/img_123.webp
        const relOld = '/' + path.relative(__dirname, fullPath).replace(/\\/g, '/');
        const relNew = '/' + path.relative(__dirname, path.join(dir, newName)).replace(/\\/g, '/');
        mappings[relOld] = relNew;
      }
    }
  }
  return mappings;
}

async function runMigration() {
  console.log('Starting image conversion to WebP...');
  const mappings = await scanAndConvert(UPLOADS_DIR);
  
  const mappedCount = Object.keys(mappings).length;
  console.log(`Conversion complete. Found ${mappedCount} images to update in DB.`);
  if (mappedCount === 0) return;

  // 1. Update settings (site_logo, site_favicon, payment_methods)
  const settings = await allQuery('SELECT * FROM settings');
  for (const row of settings) {
    let changed = false;
    let newValue = row.value;

    if (row.key === 'site_logo' || row.key === 'site_favicon') {
      if (mappings[row.value]) {
        newValue = mappings[row.value];
        changed = true;
      }
    } else if (row.key === 'payment_methods') {
      try {
        const pms = JSON.parse(row.value);
        if (Array.isArray(pms)) {
          pms.forEach(pm => {
            if (pm.image && mappings[pm.image]) {
              pm.image = mappings[pm.image];
              changed = true;
            }
          });
          if (changed) newValue = JSON.stringify(pms);
        }
      } catch (e) {}
    }
    
    if (changed) {
      await runQuery('UPDATE settings SET value = ? WHERE key = ?', [newValue, row.key]);
      console.log(`Updated setting: ${row.key}`);
    }
  }

  // 2. Update services
  const services = await allQuery('SELECT id, image FROM services WHERE image IS NOT NULL AND image != "default"');
  for (const s of services) {
    if (mappings[s.image]) {
      await runQuery('UPDATE services SET image = ? WHERE id = ?', [mappings[s.image], s.id]);
      console.log(`Updated service #${s.id}`);
    }
  }

  // 3. Update categories
  const categories = await allQuery('SELECT id, image, cover_image FROM categories');
  for (const c of categories) {
    let img = c.image;
    let cover = c.cover_image;
    let changed = false;
    
    if (img && mappings[img]) { img = mappings[img]; changed = true; }
    if (cover && mappings[cover]) { cover = mappings[cover]; changed = true; }
    
    if (changed) {
      await runQuery('UPDATE categories SET image = ?, cover_image = ? WHERE id = ?', [img, cover, c.id]);
      console.log(`Updated category #${c.id}`);
    }
  }

  // 4. Update banners
  const banners = await allQuery('SELECT id, icon FROM banners');
  for (const b of banners) {
    if (mappings[b.icon]) {
      await runQuery('UPDATE banners SET icon = ? WHERE id = ?', [mappings[b.icon], b.id]);
      console.log(`Updated banner #${b.id}`);
    }
  }

  // 5. Update orders (receipts)
  const orders = await allQuery("SELECT id, receipt_image FROM orders WHERE receipt_image IS NOT NULL AND receipt_image != ''");
  for (const o of orders) {
    if (mappings[o.receipt_image]) {
      await runQuery('UPDATE orders SET receipt_image = ? WHERE id = ?', [mappings[o.receipt_image], o.id]);
      console.log(`Updated order #${o.id} receipt`);
    }
  }

  console.log('Database references updated successfully.');
  
  // Cleanup old files
  console.log('Cleaning up old image files...');
  Object.keys(mappings).forEach(oldFileRel => {
    // Note: oldFileRel starts with /uploads, so path.join(__dirname, oldFileRel) works because __dirname is the backend root
    const absPath = path.join(__dirname, oldFileRel.replace(/^\//, '')); 
    if (fs.existsSync(absPath)) {
      try {
        fs.unlinkSync(absPath);
        console.log(`Deleted old file: ${absPath}`);
      } catch (e) {
        console.error(`Failed to delete ${absPath}`, e);
      }
    }
  });
  console.log('Migration finished!');
  process.exit(0);
}

runMigration().catch(err => {
  console.error(err);
  process.exit(1);
});
