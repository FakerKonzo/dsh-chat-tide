// 巡检补算向量自测（假 embedder，不加载模型）。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { ensureVecTables, loadVec, putVector } from '../lib/vec.js';
import { backfillVectors, runJanitor } from '../lib/janitor.js';

const FILE = fileURLToPath(new URL('../.cache/probe-backfill.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

if (!loadVec(db)) {
  console.log('SKIP: sqlite-vec 不可用');
  process.exit(0);
}
ensureVecTables(db);

const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
const f = writeFact(db, { ...base, canonicalKey: 'city', value: '杭州' });
db.prepare('UPDATE fact_version SET embedding_pending = 1 WHERE fact_id = ?').run(f.factId);
ok(runJanitor(db).embeddingBacklog.length === 1, '巡检发现积压');

const fakeEmbedder = {
  embed: async (texts) => texts.map((t, i) => {
    const v = new Float32Array(512);
    v[i] = 1;
    v[0] = 0.5;
    return v;
  }),
};

const rep = await backfillVectors(db, { embedder: fakeEmbedder, putVector, table: 'vec_fact' });
ok(rep.done === 1, '补算成功', JSON.stringify(rep));
ok(db.prepare('SELECT count(*) c FROM vec_fact').get().c === 1, '向量已写入');
ok(db.prepare('SELECT embedding_pending p FROM fact_version WHERE fact_id=?').get(f.factId).p === 0, 'pending 已清零');
ok(runJanitor(db).embeddingBacklog.length === 0, '积压清单清空');

// 幂等：再跑一次不再处理
const rep2 = await backfillVectors(db, { embedder: fakeEmbedder, putVector, table: 'vec_fact' });
ok(rep2.attempted === 0, '已补算的不重复处理');

// 失败不炸
const bad = { embed: async () => { throw new Error('boom'); } };
db.prepare('UPDATE fact_version SET embedding_pending = 1 WHERE fact_id = ?').run(f.factId);
const rep3 = await backfillVectors(db, { embedder: bad, putVector, table: 'vec_fact' });
ok(rep3.failed === 1 && rep3.done === 0, '补算失败不抛错', JSON.stringify(rep3));

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
