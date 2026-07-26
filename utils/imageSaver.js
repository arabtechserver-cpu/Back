const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function saveImage(base64Str) {
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

  // Determine file extension
  let extension = 'png';
  if (imageType.includes('jpeg') || imageType.includes('jpg')) {
    extension = 'jpg';
  } else if (imageType.includes('gif')) {
    extension = 'gif';
  } else if (imageType.includes('webp')) {
    extension = 'webp';
  } else if (imageType.includes('svg')) {
    extension = 'svg';
  }

  // Create unique filename
  const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${extension}`;

  // Save to backend/uploads directory
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, buffer);

  // Return the relative URL path
  return `/uploads/${filename}`;
}

module.exports = { saveImage };
