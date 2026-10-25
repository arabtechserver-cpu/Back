const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
const { placementKey, includesService, filterPageCatalog, validatePage, countPageServices } = require('./dist/utils/store-pages');
const group = placementKey({ categoryId: 'cat-a', groupName: 'Shared group' });
const service = { id: 'service-a', groupName: 'Shared group', isActive: true };
const own = placementKey({ serviceId: service.id });

test('sidebar counts match actual page membership including inheritance, overrides and hidden services', () => {
  const services = [service, { ...service, id: 'sibling' }, { ...service, id: 'hidden', isActive: false }, { ...service, id: 'other', categoryId: 'cat-b' }].map(item => ({ categoryId: 'cat-a', ...item }));
  const placements = { [group]: { mode: 'all', pageIds: [] }, [own]: { mode: 'selected', pageIds: ['p2'] } };
  for (const pageId of ['p1', 'p2', 'future-page']) {
    const expected = filterPageCatalog([{ id: 'cat-a', services: services.filter(s => s.categoryId === 'cat-a') }, { id: 'cat-b', services: services.filter(s => s.categoryId === 'cat-b') }], pageId, placements).reduce((total, category) => total + category.services.length, 0);
    assert.equal(countPageServices(pageId, services, placements), expected);
  }
  assert.equal(countPageServices('p1', services, placements), 1);
  assert.equal(countPageServices('p2', services, placements), 2);
});

test('one group can appear on multiple selected pages without appearing on unrelated pages', () => {
  const placements = { [group]: { mode: 'selected', pageIds: ['p1', 'p2'] } };
  assert.equal(includesService('p1', 'cat-a', service, placements), true);
  assert.equal(includesService('p2', 'cat-a', service, placements), true);
  assert.equal(includesService('p3', 'cat-a', service, placements), false);
  assert.equal(includesService('p1', 'cat-b', service, placements), false, 'identical group names in another category do not collide');
});
test('all-pages membership includes future pages and individually hidden services stay hidden', () => {
  const placements = { [group]: { mode: 'all', pageIds: [] } };
  assert.equal(includesService('future-page', 'cat-a', service, placements), true);
  assert.equal(includesService('p1', 'cat-a', { ...service, isActive: false }, placements), false);
});
test('service customization overrides its group, including explicit exclusion from every page', () => {
  const placements = { [group]: { mode: 'all', pageIds: [] }, [own]: { mode: 'selected', pageIds: ['p2'] } };
  assert.equal(includesService('p1', 'cat-a', service, placements), false);
  assert.equal(includesService('p2', 'cat-a', service, placements), true);
  placements[own].pageIds = [];
  assert.equal(includesService('p2', 'cat-a', service, placements), false);
  placements[own] = { mode: 'inherit', pageIds: [] };
  assert.equal(includesService('p1', 'cat-a', service, placements), true);
});
test('service can be placed independently without changing its siblings or the unfiltered catalog', () => {
  const categories = [{ id: 'cat-a', services: [service, { ...service, id: 'sibling' }] }, { id: 'empty', services: [] }];
  const result = filterPageCatalog(categories, 'p1', { [own]: { mode: 'all', pageIds: [] } });
  assert.equal(result.length, 1);
  assert.equal(result[0].services.length, 1);
  assert.equal(result[0].services[0].id, service.id);
  assert.equal(categories[0].services.length, 2);
  assert.equal(filterPageCatalog(categories, 'p1', {}).length, 0);
});
test('page input rejects reserved and unsafe slugs and limits publishing flags to explicit booleans', () => {
  for (const slug of ['admin', '../admin', 'x?cat=all', '<script>', '']) assert.throws(() => validatePage({ title: 'صفحة', slug }, 'id'));
  const page = validatePage({ title: ' أكواد ', slug: 'GAME-CODES', enabled: 'true', navbar: true, menu: true, description: 'test' }, 'id');
  assert.equal(page.slug, 'game-codes'); assert.equal(page.title, 'أكواد'); assert.equal(page.enabled, false); assert.equal(page.navbar, true);
});
