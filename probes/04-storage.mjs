// 存储层自测：schema、事实写入/覆盖、FTS 索引与删除、向量往返。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { indexFact, searchFacts, unindexFact } from '../lib/fts.js';
import { ensureVecTables, loadVec, putVector, knn, deleteVector } from '../lib/vec.js';

const FILE = fileURLToPath(new URL('../.cache/probe-storage.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });

const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const now = Date.now();
function insertFact({ id, user = 'u1', entity = 'u1', key = 'residence', subtype = 'profile', value, tier = 'human_explicit' }) {
  db.prepare(
    `INSERT INTO fact(fact_id,user_id,entity_id,canonical_key,subtype,status,current_version,provenance_tier,occurred_at,observed_at,updated_at)
     VALUES (?,?,?,?,?,'active',1,?,?,?,?)`,
  ).run(id, user, entity, key, subtype, tier, now, now, now);
  db.prepare(
    `INSERT INTO fact_version(fact_id,version,value,status,occurred_at,observed_at,created_at)
     VALUES (?,?,?,'active',?,?,?)`,
  ).run(id, 1, value, now, now, now);
  indexFact(db, id, value);
}

insertFact({ id: 'f1', value: '住在杭州' });
insertFact({ id: 'f2', key: 'drink_preference', value: '喜欢喝奶茶不加冰' });

// 1) 两字词召回
const hits = searchFacts(db, '杭州');
ok(hits.length === 1 && hits[0].factId === 'f1', 'FTS 两字词召回', JSON.stringify(hits));

// 2) 唯一 active 约束
let dupErr = null;
try {
  insertFact({ id: 'f3', value: '住在上海' });
} catch (e) {
  dupErr = e.message;
}
ok(dupErr !== null && /UNIQUE/.test(dupErr), '同键第二个 active 被唯一索引拦下', String(dupErr).slice(0, 50));

// 3) 覆盖：旧版本 superseded + 新版本 active（单事务）
function supersede(factId, newValue) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT current_version FROM fact WHERE fact_id = ?').get(factId);
    const next = row.current_version + 1;
    db.prepare('UPDATE fact SET status = ?, valid_to = ? WHERE fact_id = ?').run('superseded', now, factId);
    db.prepare('UPDATE fact_version SET status = ? WHERE fact_id = ? AND version = ?').run('superseded', factId, row.current_version);
    db.prepare(
      `INSERT INTO fact_version(fact_id,version,value,status,occurred_at,observed_at,created_at)
       VALUES (?,?,?,'active',?,?,?)`,
    ).run(factId, next, newValue, now, now, now);
    db.prepare('UPDATE fact SET status = ?, current_version = ?, updated_at = ? WHERE fact_id = ?').run('active', next, now, factId);
    indexFact(db, factId, newValue);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
supersede('f1', '住在上海');
const cur = db
  .prepare(`SELECT f.status AS fstatus, f.current_version AS v, vv.value, vv.status AS vstatus
              FROM fact f JOIN fact_version vv ON vv.fact_id = f.fact_id AND vv.version = f.current_version
             WHERE f.fact_id = 'f1'`)
  .get();
ok(cur.fstatus === 'active' && cur.v === 2 && cur.value === '住在上海', '覆盖后当前值正确', JSON.stringify(cur));
const old = db.prepare(`SELECT value, status FROM fact_version WHERE fact_id='f1' AND version=1`).get();
ok(old.status === 'superseded' && old.value === '住在杭州', '旧版本保留为 superseded');
ok(searchFacts(db, '杭州').length === 0 && searchFacts(db, '上海').length === 1, 'FTS 随覆盖更新（无幽灵命中）');

// 4) CAS：陈旧版本写入必须失败
const cas = db.prepare('UPDATE fact SET current_version = current_version + 1 WHERE fact_id = ? AND current_version = ?');
ok(cas.run('f1', 1).changes === 0, 'CAS 陈旧版本写入被拒');
ok(cas.run('f1', 2).changes === 1, 'CAS 正确版本写入成功');

// 5) 删除：事实 + FTS 都不再命中
db.prepare(`UPDATE fact SET status='deleted' WHERE fact_id='f2'`).run();
unindexFact(db, 'f2');
ok(searchFacts(db, '奶茶').length === 0, '删除后 FTS 无命中');

// 6) 向量往返
const vecOk = loadVec(db);
console.log(vecOk ? 'sqlite-vec 可用' : 'sqlite-vec 不可用（降级）');
if (vecOk) {
  ensureVecTables(db);
  const v = (seed) => {
    const a = new Float32Array(512);
    for (let i = 0; i < 512; i++) a[i] = Math.sin(seed * (i + 1));
    let n = 0;
    for (let i = 0; i < 512; i++) n += a[i] * a[i];
    n = Math.sqrt(n);
    for (let i = 0; i < 512; i++) a[i] /= n;
    return a;
  };
  const rowid = db.prepare(`SELECT rowid FROM fact_version WHERE fact_id='f1' AND version=2`).get().rowid;
  putVector(db, 'vec_fact', rowid, v(1));
  const near = knn(db, 'vec_fact', v(1), 1);
  ok(near.length === 1 && Number(near[0].rowid) === Number(rowid) && near[0].distance < 1e-4,
    '向量写入与 KNN 往返', JSON.stringify(near));
  // 覆盖写
  putVector(db, 'vec_fact', rowid, v(2));
  const after = knn(db, 'vec_fact', v(2), 1);
  ok(after.length === 1 && after[0].distance < 1e-4, '向量覆盖写（DELETE+INSERT）生效');
  deleteVector(db, 'vec_fact', rowid);
  ok(db.prepare('SELECT count(*) c FROM vec_fact').get().c === 0, '向量删除生效');
}

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
