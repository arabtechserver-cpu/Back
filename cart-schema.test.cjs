const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/unused';
const {CART_SCHEMA_SQL,ensureCartSchema}=require('./dist/utils/cart-schema');
const adapter=pg=>({
 $queryRawUnsafe:async sql=>(await pg.query(sql)).rows,
 $transaction:fn=>pg.transaction(async tx=>fn({$executeRawUnsafe:sql=>tx.exec(sql)})),
});
test('cart storage missing from old deployments is created without importing products or changing balances',async()=>{
 const pg=await PGlite.create();
 try{
  await pg.exec('CREATE TABLE "User" (id TEXT PRIMARY KEY,balance DOUBLE PRECISION NOT NULL); INSERT INTO "User" VALUES (\'user\',20);');
  await assert.rejects(pg.query('SELECT * FROM "CartItem"'),/does not exist/);
  assert.equal(fs.readFileSync('prisma/migrations/20261028010000_cart_storage/migration.sql','utf8').trim(),CART_SCHEMA_SQL.trim());
  await ensureCartSchema(adapter(pg));
  await pg.query('INSERT INTO "CartItem" (id,"userId","serviceId","serviceName",quantity,price,"customFields") VALUES ($1,$2,$3,$4,2,1,$5)',['item','user','service','100 💎','{"player_id":"123456789"}']);
  await ensureCartSchema(adapter(pg)); await pg.exec(CART_SCHEMA_SQL);
  const items=(await pg.query('SELECT * FROM "CartItem"')).rows;
  assert.equal(items.length,1); assert.equal(items[0].quantity,2);assert.equal(items[0].price,1);assert.ok(items[0].updatedAt);
  assert.equal((await pg.query('SELECT balance FROM "User"')).rows[0].balance,20);
  await assert.rejects(pg.query('INSERT INTO "CartItem" (id,"userId","serviceId","serviceName") VALUES (\'bad\',\'another-user\',\'s\',\'s\')'),/foreign key/);
  await pg.exec('DELETE FROM "User" WHERE id=\'user\'');
  assert.equal((await pg.query('SELECT * FROM "CartItem"')).rows.length,0);
 }finally{await pg.close();}
});
test('legacy carts retain their contents when missing detail columns are added',async()=>{
 const pg=await PGlite.create();
 try{
  await pg.exec('CREATE TABLE "User" (id TEXT PRIMARY KEY); INSERT INTO "User" VALUES (\'user\'); CREATE TABLE "CartItem" (id TEXT PRIMARY KEY,"userId" TEXT,"serviceId" TEXT,"serviceName" TEXT,quantity INTEGER,price DOUBLE PRECISION); INSERT INTO "CartItem" VALUES (\'old\',\'user\',\'service\',\'Existing package\',3,5);');
  await ensureCartSchema(adapter(pg));
  const item=(await pg.query('SELECT * FROM "CartItem"')).rows[0];
  assert.equal(item.id,'old');assert.equal(item.quantity,3);assert.equal(item.price,5);assert.equal(item.customFields,null);assert.equal(item.targetInput,null);
 }finally{await pg.close();}
});
