const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');

(async () => {
 const db = new PGlite();
 try {
  await db.exec('CREATE TABLE "User" (id TEXT PRIMARY KEY, username TEXT UNIQUE, role TEXT, status TEXT, password TEXT, "tokenVersion" INTEGER, "deletedAt" TIMESTAMP, "updatedAt" TIMESTAMP, balance DOUBLE PRECISION);');
  const oldHash = await bcrypt.hash('old-private-password', 4);
  for (const [id, username, role] of [['target','admin','admin'],['other-admin','another-admin','admin'],['customer','customer','user']]) {
   await db.query('INSERT INTO "User" VALUES ($1,$2,$3,$4,$5,$6,NULL,CURRENT_TIMESTAMP,$7)', [id,username,role,'active',oldHash,4,150]);
  }
  const sql = fs.readFileSync(path.join(__dirname, 'prisma/migrations/20261011195000_recover_admin_password/migration.sql'), 'utf8');
  await db.exec(sql);
  const target = (await db.query('SELECT * FROM "User" WHERE id=$1', ['target'])).rows[0];
  assert.equal(await bcrypt.compare('admin123', target.password), true);
  assert.notEqual(target.password, 'admin123');
  assert.equal(await bcrypt.compare('old-private-password', target.password), false);
  assert.equal(target.tokenVersion, 5);
  assert.equal(target.role, 'admin');
  assert.equal(target.status, 'active');
  assert.equal(target.balance, 150);
  for (const id of ['other-admin','customer']) {
   const user = (await db.query('SELECT * FROM "User" WHERE id=$1', [id])).rows[0];
   assert.equal(user.password, oldHash);
   assert.equal(user.tokenVersion, 4);
   assert.equal(user.balance, 150);
  }
  // A regular account named admin must never gain admin access or be reset.
  await db.query('UPDATE "User" SET role=$1,password=$2,"tokenVersion"=$3 WHERE id=$4', ['user',oldHash,9,'target']);
  await db.exec(sql);
  const regular = (await db.query('SELECT * FROM "User" WHERE id=$1', ['target'])).rows[0];
  assert.equal(regular.password, oldHash);
  assert.equal(regular.tokenVersion, 9);
  assert.equal(regular.role, 'user');
  console.log('PASS: recovery hashes the requested password, revokes old sessions, preserves account/balances and ignores unrelated or non-admin accounts.');
 } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
