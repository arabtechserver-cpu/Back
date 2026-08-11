const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

async function saveImage(base64Str) {
  if (!base64Str) return null;

  // If it's already a URL or path (e.g. starts with '/' or 'http'), keep it as-is
  if (base64Str.startsWith('/') || base64Str.startsWith('http')) {
    return base64Str;
  }

  // Check if it is a base64 data URI
  const matches = base64Str.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    return base64Str; // Return as-is if it's not a standard base64 data URI
  }

  const imageType = matches[1]; // e.g. 'image/png' or 'image/jpeg'
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');

  // Keep SVGs intact
  if (imageType.includes('svg')) {
    const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.svg`;
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    return `/uploads/${filename}`;
  }

  // Create unique filename for WebP
  const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webp`;
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const filePath = path.join(uploadsDir, filename);

  try {
    // Convert to WebP using sharp
    await sharp(buffer)
      .webp({ quality: 80, effort: 4 })
      .toFile(filePath);
    return `/uploads/${filename}`;
  } catch (error) {
    console.error("Error converting image to webp with sharp:", error);
    // Fallback to saving original format if conversion fails
    let ext = 'png';
    if (imageType.includes('jpeg') || imageType.includes('jpg')) ext = 'jpg';
    else if (imageType.includes('gif')) ext = 'gif';
    else if (imageType.includes('webp')) ext = 'webp';
    
    const fallbackFilename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, fallbackFilename), buffer);
    return `/uploads/${fallbackFilename}`;
  }
}

module.exports = { saveImage };
