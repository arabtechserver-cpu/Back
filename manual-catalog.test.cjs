const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const catalog = require('./src/data/zoalna-catalog.json');
const sql = fs.readFileSync('prisma/migrations/20261028000000_manual_store_catalog/migration.sql','utf8');

test('snapshot covers all four pages and contains only names, options and source identifiers', () => {
  assert.equal(catalog.sections.length,4);
  assert.equal(catalog.products.length,27);
  assert.equal(catalog.products.reduce((n,p) => n+p.packages.length,0),237);
  assert.equal(new Set(catalog.products.flatMap(p => p.packages.map(v => v.id))).size,237);
  assert.ok(catalog.products.every(p=>p.packages.every(v=>v.name!=='null')));
  assert.ok(catalog.products.every(p => p.pageIds.length && p.packages.every(v => v.name)));
  assert.ok(!/"(?:price|prices|credit|margin|cost|originalPrice|purchase_price)"\s*:/i.test(JSON.stringify(catalog)));
  assert.equal(catalog.products.find(p=>p.slug==='redotpay').packages.length,5);
  assert.ok(!fs.readFileSync('src/server.ts','utf8').includes('installManualCatalog'), 'server restarts must not import catalog data');
});

test('PostgreSQL deployment migration is repeatable, preserves manual edits and publishes exact group memberships', async () => {
 const pg = await PGlite.create();
 try {
  await pg.exec(`CREATE TABLE "Setting" (key TEXT PRIMARY KEY,value TEXT NOT NULL,"createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP NOT NULL);
   CREATE TABLE "DhruCategory" (id TEXT PRIMARY KEY,name TEXT NOT NULL,"createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
   CREATE TABLE "DhruService" (id TEXT PRIMARY KEY,"dhruId" TEXT UNIQUE NOT NULL,name TEXT NOT NULL,"originalName" TEXT NOT NULL,"groupName" TEXT NOT NULL,credit DOUBLE PRECISION NOT NULL,margin DOUBLE PRECISION DEFAULT 0,time TEXT NOT NULL,"isActive" BOOLEAN DEFAULT true,"providerId" TEXT,"categoryId" TEXT REFERENCES "DhruCategory"(id),"requiresCustom" TEXT,"createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP NOT NULL);
   INSERT INTO "DhruCategory" (id,name) VALUES ('existing-category','My manual services');`);
  const product = catalog.products[0], option = product.packages[0];
  await pg.query('INSERT INTO "DhruService" (id,"dhruId",name,"originalName","groupName",credit,margin,time,"isActive","categoryId","updatedAt") VALUES ($1,$2,$3,$3,$4,7,2,\'custom time\',false,\'existing-category\',CURRENT_TIMESTAMP)', ['existing-service','pkg_custom',option.name,product.name]);
  await pg.exec(sql);
  await pg.query('UPDATE "DhruService" SET credit=11,margin=3,name=\'Admin renamed this\' WHERE "dhruId"=$1',['pkg_zoalna_'+catalog.products[1].packages[0].id]);
  await pg.exec(sql);
  assert.equal(Number((await pg.query('SELECT COUNT(*) n FROM "DhruService"')).rows[0].n),237);
  const old = (await pg.query('SELECT * FROM "DhruService" WHERE id=\'existing-service\'')).rows[0];
  assert.equal(old.credit,7); assert.equal(old.margin,2); assert.equal(old.isActive,false); assert.equal(old.time,'custom time');
  const renamed = (await pg.query('SELECT * FROM "DhruService" WHERE "dhruId"=$1',['pkg_zoalna_'+catalog.products[1].packages[0].id])).rows[0];
  assert.equal(renamed.name,'Admin renamed this'); assert.equal(renamed.credit,11); assert.equal(renamed.margin,3);
  const pages = (await pg.query('SELECT value FROM "Setting" WHERE key LIKE \'store-page:%\'')).rows.map(r=>JSON.parse(r.value));
  assert.deepEqual(pages.map(p=>p.title).sort(),catalog.sections.map(s=>s.title).sort());
  assert.ok(pages.every(p=>p.enabled && p.navbar && p.menu));
  const placements = (await pg.query('SELECT key,value FROM "Setting" WHERE key LIKE \'store-placement:%\'')).rows;
  assert.equal(placements.length,27);
  const groups = (await pg.query('SELECT DISTINCT "categoryId","groupName" FROM "DhruService"')).rows;
  for (const group of groups) {
   const key = `store-placement:group:${encodeURIComponent(group.categoryId)}:${encodeURIComponent(group.groupName)}`;
   const placement = placements.find(p=>p.key===key); assert.ok(placement,`missing ${key}`);
   const source = catalog.products.find(p=>p.name===group.groupName);
   assert.deepEqual(JSON.parse(placement.value).pageIds.sort(),source.pageIds.map(id=>'zoalna-'+id).sort());
  }
  assert.equal(Number((await pg.query('SELECT COUNT(*) n FROM "DhruService" WHERE "providerId" IS NOT NULL')).rows[0].n),0);
  assert.equal(Number((await pg.query('SELECT COUNT(*) n FROM "DhruService" WHERE id<>\'existing-service\' AND credit=0 AND margin=0')).rows[0].n),235);
 } finally { await pg.close(); }
});
