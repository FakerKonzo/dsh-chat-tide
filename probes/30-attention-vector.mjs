// 关注点向量路由：命中直接唤醒、相关但不在关注点内走探索
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { ensureVecTables, loadVec, putVector } from '../lib/vec.js';
import { addAttention, attentionRowid, listAttention } from '../lib/attention.js';
import { decideRoute } from '../lib/route-decision.js';

const FILE = fileURLToPath(new URL('../.cache/probe-attvec.db', import.meta.url));
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

const DIM = 512;
const mk = (i) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};

// 两条事实：f1 对应关注点方向，f2 对应"相关但不在关注点"的方向
for (const [id, idx, val] of [
  ['f1', 0, '测试主题一'],
  ['f2', 1, '测试主题二'],
]) {
  db.prepare(
    `INSERT INTO fact(fact_id,user_id,entity_id,canonical_key,subtype,status,current_version,provenance_tier,updated_at)
     VALUES (?,'u1','u1',?,'preference','active',1,'human_explicit',?)`,
  ).run(id, 'pref.owner.' + id, Date.now());
  const vrow = db.prepare("INSERT INTO fact_version(fact_id,version,value,status,created_at) VALUES (?,1,?,'active',?) RETURNING rowid").get(id, val, Date.now());
  putVector(db, 'vec_fact', vrow.rowid, mk(idx));
}

const attId = addAttention(db, { kind: 'topic', label: '屋顶光伏方案', weight: 0.9 });
const rowid = attentionRowid(db, attId);
ok(typeof rowid === 'number' || typeof rowid === 'bigint', '关注点有 rowid', String(rowid));
putVector(db, 'vec_attention', rowid, mk(0));

const cfg = {
  routing: {
    high: 0.55, low: 0.42, margin: 0.02, uncertainPolicy: 'reject', budget: 100000,
    llmFallback: false, exemplarThreshold: 0.5, ambientReplyProbability: 0.1,
    attentionThreshold: 0.5, attentionSoftBand: 0.05, attentionMargin: 0.04, maxWakesPerDay: 0, minWakeIntervalMinutes: 0, ftsRescue: true, l2Threshold: 0.45,
  },
  attention: { enabled: true },
};
const binding = { adapter: 'qq', scope: 'group', peerId: 'g1', conversationKey: 'qq:g1' };

const same = { embed: async () => [mk(0)] };
const r1 = await decideRoute({ db, cfg, binding, text: '光伏那个咋样了', isMentioned: false, embedder: same, vecReady: true, random: () => 0.999, now: Date.now() });
ok(r1.action === 'wake' && r1.reason === 'attention-hit', '关注点命中直接唤醒', JSON.stringify({ r: r1.reason, s: r1.detail.attentionScore }));
ok(listAttention(db)[0]?.hits === 1, '命中计数 +1', String(listAttention(db)[0]?.hits));

// 相关（命中 f2）但不在关注点：掷空拒、掷中唤醒
const other = { embed: async () => [mk(1)] };
const r2 = await decideRoute({ db, cfg, binding, text: '另一个话题怎么样了', isMentioned: false, embedder: other, vecReady: true, random: () => 0.99, now: Date.now() });
ok(r2.reason === 'explore-miss', '相关但不在关注点 → 掷空拒', r2.reason);
const r3 = await decideRoute({ db, cfg, binding, text: '另一个话题怎么样了', isMentioned: false, embedder: other, vecReady: true, random: () => 0.01, now: Date.now() });
ok(r3.action === 'wake' && r3.reason === 'ambient-explore', '相关但不在关注点 → 掷中唤醒', JSON.stringify({ a: r3.action, r: r3.reason }));

// 完全无关 → 直接拒，连探索机会都没有
const nowhere = { embed: async () => [mk(9)] };
const r4 = await decideRoute({ db, cfg, binding, text: '今天吃什么', isMentioned: false, embedder: nowhere, vecReady: true, random: () => 0.001, now: Date.now() });
ok(r4.action === 'reject' && r4.reason === 'irrelevant-ambient', '无关消息直接拒', r4.reason);

// 关注点关闭 → 不走直接唤醒
const cfgOff = { ...cfg, attention: { enabled: false } };
const r5 = await decideRoute({ db, cfg: cfgOff, binding, text: '光伏那个咋样了', isMentioned: false, embedder: same, vecReady: true, random: () => 0.99, now: Date.now() });
ok(r5.reason !== 'attention-hit', '关掉关注点则不直接唤醒', r5.reason);

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
