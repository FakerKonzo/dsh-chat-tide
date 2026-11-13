// 数据库自洽性：完整性、外键、索引与向量一致、设置键合法
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase, SCHEMA_VERSION } from '../lib/db.js';
import { writeFact, deleteFact } from '../lib/facts.js';
import { appendEvent } from '../lib/events.js';
import { ensureVecTables, loadVec, putVector } from '../lib/vec.js';
import { addAttention } from '../lib/attention.js';
import { isKnownKey } from '../lib/settings.js';

const FILE = fileURLToPath(new URL('../.cache/probe-integrity.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 文件完整性
const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
ok(integrity === 'ok', 'integrity_check', String(integrity));
const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
ok(fkErrors.length === 0, '无外键冲突', JSON.stringify(fkErrors).slice(0, 80));
ok(db.prepare('PRAGMA user_version').get()?.user_version === SCHEMA_VERSION, 'schema 版本与代码一致', String(SCHEMA_VERSION));

// 2) 造数据后校验：事实 / 版本 / FTS / 向量
const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
const c1 = writeFact(db, { ...base, canonicalKey: 'pref.owner.city', subtype: 'preference', value: '杭州', scope: 'private' });
const c2 = writeFact(db, { ...base, canonicalKey: 'pref.owner.city', subtype: 'preference', value: '上海', scope: 'private', occurredAt: Date.now() + 1000, observedAt: Date.now() + 1000 });
appendEvent(db, { eventId: 'ev-1', eventType: 'observation', content: '今天吃了三个饼', occurredAt: Date.now(), conversationKey: 'qq:g1', userId: 'u1', scope: 'group' });
addAttention(db, { kind: 'topic', label: '屋顶光伏方案', weight: 0.9 });

const vecReady = loadVec(db);
if (vecReady) {
  ensureVecTables(db);
  putVector(db, 'vec_fact', c2.versionRowid, new Float32Array(512).fill(0.0));
}

// FTS 与活跃事实一一对应
const ftsFacts = db.prepare('SELECT count(*) c FROM fact_fts').get().c;
const activeFacts = db.prepare("SELECT count(*) c FROM fact WHERE status='active'").get().c;
ok(ftsFacts === activeFacts, '事实全文索引条数 == 活跃事实数', `${ftsFacts}/${activeFacts}`);

// 每个活跃事实的当前版本存在且为 active
const orphanCurrent = db
  .prepare(
    `SELECT count(*) c FROM fact f WHERE f.status='active' AND NOT EXISTS (
       SELECT 1 FROM fact_version v WHERE v.fact_id=f.fact_id AND v.version=f.current_version AND v.status='active')`,
  )
  .get().c;
ok(orphanCurrent === 0, '当前版本指针有效', String(orphanCurrent));

// 删除以后索引与向量都不再挂着（用另一条独立事实，避免同键覆盖干扰）
const c3 = writeFact(db, { ...base, canonicalKey: 'pref.owner.hobby', subtype: 'preference', value: '钓鱼', scope: 'private' });
const beforeFacts = db.prepare("SELECT count(*) c FROM fact WHERE status='active'").get().c;
deleteFact(db, c3.factId, { reason: 'probe' });
const afterFacts = db.prepare("SELECT count(*) c FROM fact WHERE status='active'").get().c;
const afterFts = db.prepare('SELECT count(*) c FROM fact_fts').get().c;
ok(afterFacts === beforeFacts - 1 && afterFts === afterFacts, '删除后索引同步收敛', `${afterFacts}/${afterFts}`);
if (vecReady) {
  const vecOrphan = db
    .prepare(
      `SELECT count(*) c FROM vec_fact v WHERE NOT EXISTS (
         SELECT 1 FROM fact_version fv JOIN fact f ON f.fact_id=fv.fact_id AND f.current_version=fv.version
          WHERE fv.rowid=v.rowid AND f.status='active')`,
    )
    .get().c;
  ok(vecOrphan === 0, '删除后无孤儿向量', String(vecOrphan));
}

// 3) 设置表只允许白名单键
db.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('routing.high','0.5',?) ON CONFLICT(key) DO NOTHING").run(Date.now());
const settingsRows = db.prepare('SELECT key FROM settings').all();
ok(settingsRows.every((r) => isKnownKey(r.key)), '设置键均在白名单', JSON.stringify(settingsRows.map((r) => r.key)));

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);