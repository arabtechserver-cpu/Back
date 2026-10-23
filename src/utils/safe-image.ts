import sharp from 'sharp';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
sharp.cache(false);
sharp.concurrency(1);

export class InvalidImageError extends Error {}
export class ImageBusyError extends InvalidImageError {}
let activeDecoders = 0;

/** Decode only raster formats, bound decompression, and discard metadata/trailing payloads. */
export async function sanitizeImageDataUrl(input: unknown, allowGif = false) {
  if (typeof input !== 'string' || input.length > Math.ceil(MAX_BYTES / 3) * 4 + 100) {
    throw new InvalidImageError('حجم الصورة يجب ألا يتجاوز 10 ميجابايت');
  }
  const match = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (!match || (!allowGif && match[1] === 'image/gif')) {
    throw new InvalidImageError('يسمح فقط بصورة JPG أو PNG أو WEBP سليمة');
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64') !== match[2]) {
    throw new InvalidImageError('ترميز الصورة غير صالح');
  }
  const expectedFormat = match[1].replace('image/', '').replace('jpg', 'jpeg');
  // Reject vector/document inputs before passing any bytes to an image decoder.
  const signature = buffer.subarray(0, 12);
  const format = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff ? 'jpeg'
    : signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
    : ['GIF87a', 'GIF89a'].includes(signature.toString('ascii', 0, 6)) ? 'gif' : null;
  if (format !== expectedFormat) throw new InvalidImageError('محتوى الملف لا يطابق نوع الصورة');
  if (activeDecoders >= 1) throw new ImageBusyError('جاري معالجة صورة أخرى؛ يرجى المحاولة بعد لحظات');
  activeDecoders++;
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning', sequentialRead: true });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages || 1) > 1) {
      throw new Error('Image dimensions or animation exceed limits');
    }
    const cleaned = await image.rotate().webp({ quality: 90 }).toBuffer();
    if (cleaned.length > MAX_BYTES) throw new Error('Output image too large');
    return { buffer: cleaned, mimeType: 'image/webp', extension: 'webp', dataUrl: `data:image/webp;base64,${cleaned.toString('base64')}` };
  } catch {
    throw new InvalidImageError('الصورة تالفة أو تتجاوز الأبعاد المسموح بها؛ يرجى رفع صورة ثابتة سليمة');
  } finally {
    activeDecoders--;
  }
}
