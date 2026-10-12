const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { iterateRows } = require('./dist/utils/batched-rows');
const { writeJsonSnapshot } = require('./dist/utils/json-snapshot');
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borai-memory-test-'));
  const files = [];
  const file = name => { const result = path.join(dir, name); files.push(result, result + '.partial'); return result; };
  try {
    const queries = [];
    const rows = Array.from({ length: 7 }, (_, n) => ({ id: String(n + 1), status: 'processing' }));
    const model = { async findMany(args) {
      queries.push(args);
      const after = args.where?.AND?.[1]?.id?.gt || '';
      return rows.filter(r => r.id > after && r.status === 'processing').slice(0, args.take);
    } };
    const seen = [];
    for await (const row of iterateRows(model, { where: { status: 'processing' }, select: { id: true } }, 2)) {
      seen.push(row.id); row.status = 'completed';
    }
    assert.deepEqual(seen, ['1', '2', '3', '4', '5', '6', '7']);
    assert.deepEqual(queries[1].where.AND[0], { status: 'processing' });
    await assert.rejects(async () => { for await (const r of iterateRows(model, {}, 0)) {} }, /positive integer/);
    const stableModel = { async findMany(args) { return args.where ? [] : [{ id: 'a', date: new Date('2026-01-01'), data: 'value' }]; } };
    const small = file('small.json');
    const counts = await writeJsonSnapshot(small, { version: '2.0', summary: { users: 1 } }, { users: { model: stableModel, batchSize: 1 } });
    assert.deepEqual(counts, { users: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(small)), { version: '2.0', summary: { users: 1 }, users: [{ id: 'a', date: '2026-01-01T00:00:00.000Z', data: 'value' }] });
    const failed = file('failed.json');
    await assert.rejects(writeJsonSnapshot(failed, {}, { users: { model: { findMany: async () => { throw new Error('Database unavailable'); } } } }), /Database unavailable/);
    assert.equal(fs.existsSync(failed), false);
    assert.equal(fs.existsSync(failed + '.partial'), false);
    const existing = file('existing.json');
    fs.writeFileSync(existing + '.partial', 'keep previous interrupted backup');
    await assert.rejects(writeJsonSnapshot(existing, {}, { users: { model: stableModel } }), /EEXIST/);
    assert.equal(fs.readFileSync(existing + '.partial', 'utf8'), 'keep previous interrupted backup');
    let release;
    const waiting = { findMany: () => new Promise(resolve => { release = () => resolve([]); }) };
    const first = writeJsonSnapshot(file('first.json'), {}, { rows: { model: waiting } });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(writeJsonSnapshot(file('overlap.json'), {}, {}), /قيد الإنشاء/);
    release(); await first;
    let n = 0;
    const largeModel = { async findMany(args) {
      assert.equal(args.take, 1);
      return n < 256 ? [{ id: String(++n).padStart(4, '0'), data: 'x'.repeat(1024 * 1024) }] : [];
    } };
    const large = file('large.json');
    assert.deepEqual(await writeJsonSnapshot(large, { version: '2.0' }, { images: { model: largeModel, batchSize: 1 } }), { images: 256 });
    assert.ok(fs.statSync(large).size > 256 * 1024 * 1024);
    console.log('PASS: pagination during mutations, JSON compatibility, atomic failure, partial ownership, concurrent backup guard, 256 MiB streamed snapshot under 128 MiB heap');
    process.env.JWT_SECRET = 'memory-regression-only-secret-1234567890';
    const { prisma } = require('./dist/utils/prisma');
    const original = prisma.dhruCategory.findMany;
    let calls = 0;
    prisma.dhruCategory.findMany = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 50)); return []; };
    const express = require('express');
    const { default: router, invalidateDhruServicesCache } = require('./dist/routes/dhru');
    const app = express(); app.use('/api/dhru', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port + '/api/dhru/services?view=pricing';
    try {
      const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(url)));
      assert.equal(calls, 1, 'Concurrent misses must share the database query');
      for (const response of responses) assert.deepEqual(await response.json(), []);
      const conditional = await fetch(url, { headers: { 'If-None-Match': responses[0].headers.get('etag') } });
      assert.equal(conditional.status, 304);
      invalidateDhruServicesCache();
      await (await fetch(url)).arrayBuffer();
      assert.equal(calls, 2);
      console.log('PASS: concurrent pricing cache misses, conditional responses, invalidation');
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      prisma.dhruCategory.findMany = original; await prisma.$disconnect();
    }
  } finally {
    for (const target of files) fs.rmSync(target, { force: true });
    fs.rmdirSync(dir);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
