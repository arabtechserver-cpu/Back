const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
process.env.JWT_SECRET = 'isolated-catalog-image-test-secret-long-enough';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
const { prisma } = require('./dist/utils/prisma');
const { catalogImageKey, attachCatalogImages } = require('./dist/utils/catalog-images');
const { sanitizeImageDataUrl } = require('./dist/utils/safe-image');
after(() => prisma.$disconnect());

test('catalog artwork is bounded WebP and small images are not enlarged', async () => {
  const input = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#3680bb' } }).png().toBuffer();
  const output = await sanitizeImageDataUrl('data:image/png;base64,' + input.toString('base64'), false, 'catalog');
  const metadata = await sharp(output.buffer).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 960);
  assert.equal(metadata.height, 480);
  assert.ok(output.buffer.length < input.length);
  const small = await sharp({ create: { width: 64, height: 32, channels: 4, background: '#55884400' } }).png().toBuffer();
  const result = await sanitizeImageDataUrl('data:image/png;base64,' + small.toString('base64'), false, 'catalog');
  assert.equal((await sharp(result.buffer).metadata()).width, 64);
});

test('group artwork is scoped by category and service artwork does not replace the group image', async () => {
  const original = prisma.setting.findMany;
  prisma.setting.findMany = async () => [
    { key: catalogImageKey({ categoryId: 'cat-a', groupName: 'Free Fire: ID' }), value: '/api/upload/group.webp' },
    { key: catalogImageKey({ serviceId: 's1' }), value: '/api/upload/service.webp' }
  ];
  try {
    const result = await attachCatalogImages([
      { id: 'cat-a', services: [{ id: 's1', groupName: 'Free Fire: ID' }, { id: 's2', groupName: 'Free Fire: ID' }] },
      { id: 'cat-b', services: [{ id: 's3', groupName: 'Free Fire: ID' }] }
    ]);
    assert.equal(result[0].services[0].imageUrl, '/api/upload/service.webp');
    assert.equal(result[0].services[1].groupImageUrl, '/api/upload/group.webp');
    assert.equal(result[1].services[0].groupImageUrl, null);
    assert.equal(result[0].services[1].imageUrl, null);
  } finally { prisma.setting.findMany = original; }
});
