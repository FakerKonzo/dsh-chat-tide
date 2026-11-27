// 路由层作用域过滤自测：群聊不得因命中私聊记忆而唤醒（与注入层 injectionScopes 同一套规则）
// 用临时 SQLite 库（每个场景独立一个库，避免向量互相干扰），跑完清理。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { ensureVecTables, loadVec, putVector } from '../lib/vec.js';
import { writeFact } from '../lib/facts.js';
import { appendEvent } from '../lib/events.js';
import { decideRoute } from '../lib/route-decision.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const DIM = 512;
// 查询向量 e0（单位长度）。distanceToCosine 能还原出下面构造的余弦。
const V = (() => {
  const a = new Float32Array(DIM);
  a[0] = 1;
  return a;
})();
// 造一条与查询余弦为 c 的单位向量（余弦 c = 1 - d^2/2）
const cosVec = (c) => {
  const a = new Float32Array(DIM);
  a[0] = c;
  a[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return a;
};
const embedder = { embed: async () => [V] };

// 每个场景独立建库，避免向量表跨场景互相命中
function mkDb(tag) {
  const file = fileURLToPath(new URL(`../.cache/probe-84-route-${tag}.db`, import.meta.url));
  rmSync(file, { force: true });
  for (const ext of ['-wal', '-shm']) rmSync(file + ext, { force: true });
  const db = openDatabase(file);
  if (!loadVec(db)) return { db, file, vec: false };
  ensureVecTables(db);
  return { db, file, vec: true };
}
function closeDb(db, file) {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  for (const ext of ['', '-wal', '-shm']) rmSync(file + ext, { force: true });
}

const putFact = (db, { key, value, scope, cos }) => {
  const out = writeFact(db, {
    userId: 'U1',
    entityId: 'U1',
    assertedBy: 'U1',
    subjectId: 'U1',
    provenanceTier: 'human_explicit',
    canonicalKey: key,
    subtype: 'profile',
    value,
    scope,
  });
  putVector(db, 'vec_fact', out.versionRowid, cosVec(cos));
  return out.factId;
};
const putEvent = (db, { id, content, scope, cos, conversationKey }) => {
  appendEvent(db, { eventId: id, eventType: 'observation', content, scope, conversationKey, occurredAt: Date.now() });
  const row = db.prepare('SELECT rowid FROM event WHERE event_id = ?').get(id);
  putVector(db, 'vec_event', row.rowid, cosVec(cos));
};

const routing = {
  high: 0.55,
  low: 0.42,
  margin: 0.02,
  l2Threshold: 0.45,
  uncertainPolicy: 'reject',
  budget: 1000,
  llmFallback: false,
  exemplarThreshold: 0.5,
  ambientReplyProbability: 1,
  ftsRescue: true,
  maxWakesPerDay: 0,
  minWakeIntervalMinutes: 0,
};
// context 缺省时按注入侧默认：unifySessions=false、groupExcludePrivate=true
const makeCfg = (context) => ({ routing, attention: { enabled: false }, context });
const groupBinding = (peer, conversationKey) => ({ adapter: 'qq', scope: 'group', peerId: peer, conversationKey });

// 预检：sqlite-vec 不可用则跳过
{
  const t = mkDb('probe');
  if (!t.vec) {
    console.log('SKIP: sqlite-vec 不可用');
    closeDb(t.db, t.file);
    process.exit(0);
  }
  closeDb(t.db, t.file);
}

// (a) 群聊默认（groupExcludePrivate 默认 true）：只有私聊记忆靠近，不得唤醒
{
  const { db, file } = mkDb('a');
  putFact(db, { key: 'private_secret', value: '主人的私聊地址是某条路88号', scope: 'private', cos: 1 });
  putEvent(db, { id: 'evt-p-a', content: '私聊里说了屋顶光伏方案', scope: 'private', cos: 1, conversationKey: 'qq:p-a' });
  const r = await decideRoute({
    db,
    cfg: makeCfg({}),
    binding: groupBinding('gA', 'qq:gA'),
    text: '屋顶光伏方案怎么样了',
    embedder,
    vecReady: true,
    random: () => 0.1,
  });
  ok(r.action === 'reject', '(a) 群聊默认：私聊记忆不能唤醒', JSON.stringify({ action: r.action, reason: r.reason }));
  ok(r.detail.top1 === 0 && r.detail.factTop1 === 0, '(a) 命中全被过滤后 top1/factTop1 归零', JSON.stringify({ top1: r.detail.top1, factTop1: r.detail.factTop1 }));
  ok(r.detail.verdict !== 'relevant_ambient', '(a) 未误判为相关', String(r.detail.verdict));
  closeDb(db, file);
}

// (b0) 只开统一会话、屏蔽仍生效：与注入层一致，私聊仍被排除
{
  const { db, file } = mkDb('b0');
  putFact(db, { key: 'private_secret', value: '私聊里的秘密', scope: 'private', cos: 1 });
  putEvent(db, { id: 'evt-p-b0', content: '私聊里说了屋顶光伏方案', scope: 'private', cos: 1, conversationKey: 'qq:p-b0' });
  const r = await decideRoute({
    db,
    cfg: makeCfg({ unifySessions: true }),
    binding: groupBinding('gB0', 'qq:gB0'),
    text: '屋顶光伏方案怎么样了',
    embedder,
    vecReady: true,
    random: () => 0.1,
  });
  ok(r.action === 'reject', '(b0) 只开统一会话仍屏蔽私聊（同注入层）', JSON.stringify({ action: r.action, reason: r.reason }));
  ok(r.detail.top1 === 0, '(b0) top1 归零', String(r.detail.top1));
  closeDb(db, file);
}

// (b) 统一会话完全放开（unifySessions=true 且 groupExcludePrivate=false）：私聊记忆可命中
{
  const { db, file } = mkDb('b');
  putFact(db, { key: 'private_secret', value: '主人的私聊地址是某条路88号', scope: 'private', cos: 1 });
  putEvent(db, { id: 'evt-p-b', content: '私聊里说了屋顶光伏方案', scope: 'private', cos: 1, conversationKey: 'qq:p-b' });
  const r = await decideRoute({
    db,
    cfg: makeCfg({ unifySessions: true, groupExcludePrivate: false }),
    binding: groupBinding('gB', 'qq:gB'),
    text: '屋顶光伏方案怎么样了',
    embedder,
    vecReady: true,
    random: () => 0.1,
  });
  ok(r.action === 'wake', '(b) 放开作用域后私聊记忆可命中并唤醒', JSON.stringify({ action: r.action, reason: r.reason }));
  ok(r.detail.factTop1 > 0.9, '(b) factTop1 恢复为高位', String(r.detail.factTop1?.toFixed?.(3) ?? r.detail.factTop1));
  ok(r.detail.verdict === 'relevant_ambient', '(b) 判为相关', String(r.detail.verdict));
  closeDb(db, file);
}

// (c) 私聊（scope==='c2c'）永远放行，不受作用域过滤影响
{
  const { db, file } = mkDb('c');
  putFact(db, { key: 'private_secret', value: '私聊里的秘密', scope: 'private', cos: 1 });
  const r = await decideRoute({
    db,
    cfg: makeCfg({}),
    binding: { adapter: 'qq', scope: 'c2c', peerId: 'pC', conversationKey: 'qq:pC' },
    text: '随便说点什么',
    embedder,
    vecReady: true,
    random: () => 0.999, // 即使探索概率再低也放行
  });
  ok(r.action === 'wake' && r.reason === 'private-chat', '(c) 私聊直接放行', JSON.stringify({ action: r.action, reason: r.reason }));
  closeDb(db, file);
}

// (d) FTS 救援也要按作用域过滤：灰区里私聊事实的 FTS 命中不得把群聊救活
{
  const { db, file } = mkDb('d');
  // 群聊事件向量 cos=0.45（灰区，uncertain），内容不含查询词
  putEvent(db, { id: 'evt-g-d', content: '今天随便聊聊天', scope: 'group', cos: 0.45, conversationKey: 'qq:gD' });
  // 私聊事实向量很远，但 FTS 与查询高度重合
  putFact(db, { key: 'private_detail', value: '屋顶光伏 方案 详细记录', scope: 'private', cos: -1 });

  const rDefault = await decideRoute({
    db,
    cfg: makeCfg({}),
    binding: groupBinding('gD', 'qq:gD'),
    text: '屋顶光伏方案',
    embedder,
    vecReady: true,
    random: () => 0.1,
  });
  ok(rDefault.action === 'reject', '(d) 群聊默认：私聊 FTS 命中不救活灰区', JSON.stringify({ action: rDefault.action, reason: rDefault.reason }));
  ok(rDefault.detail.verdict !== 'relevant_ambient', '(d) 未因私聊 FTS 翻成相关', String(rDefault.detail.verdict));

  // 对照：同样的数据，放开作用域后同一条私聊 FTS 命中能救活
  const rOpen = await decideRoute({
    db,
    cfg: makeCfg({ unifySessions: true, groupExcludePrivate: false }),
    binding: groupBinding('gD2', 'qq:gD2'),
    text: '屋顶光伏方案',
    embedder,
    vecReady: true,
    random: () => 0.1,
  });
  ok(rOpen.action === 'wake', '(d) 放开作用域后同样的 FTS 命中可救活', JSON.stringify({ action: rOpen.action, via: rOpen.detail?.verdict }));
  ok((rOpen.detail.ftsOverlap ?? 0) > 0, '(d) 对照用例确实走了 FTS 救援', String(rOpen.detail.ftsOverlap));
  closeDb(db, file);
}

// (e) cfg.context 整体缺失：按注入侧默认（排除私聊），不得唤醒
{
  const { db, file } = mkDb('e');
  putFact(db, { key: 'private_secret', value: '私聊里的秘密', scope: 'private', cos: 1 });
  putEvent(db, { id: 'evt-p-e', content: '私聊里说了屋顶光伏方案', scope: 'private', cos: 1, conversationKey: 'qq:p-e' });
  const r = await decideRoute({
    db,
    cfg: makeCfg(undefined), // 没有 context
    binding: groupBinding('gE', 'qq:gE'),
    text: '屋顶光伏方案怎么样了',
    embedder,
    vecReady: true,
    random: () => 0.1,
  });
  ok(r.action === 'reject' && r.detail.top1 === 0, '(e) cfg.context 缺失时按默认排除私聊', JSON.stringify({ action: r.action, top1: r.detail.top1 }));
  closeDb(db, file);
}

{
  const { db, file } = mkDb('crowded');
  for (let i = 0; i < 12; i++) {
    putEvent(db, { id: 'private-' + i, content: '屋顶光伏', scope: 'private', cos: 1, conversationKey: 'qq:p' });
  }
  putEvent(db, { id: 'group', content: '去年我们讨论过屋顶光伏发电', scope: 'group', cos: 0.8, conversationKey: 'qq:g' });
  for (const useVec of [true, false]) {
    const result = await decideRoute({ db, cfg: makeCfg({}), binding: groupBinding('g', 'qq:g'), text: '屋顶光伏',
      embedder, vecReady: useVec, random: () => 0 });
    ok(result.action === 'wake' && (useVec ? result.detail.top1 > 0.79 : result.detail.ftsOverlap > 0),
      '私聊占满前十二名时仍能召回群聊经历 ' + (useVec ? '向量' : '关键词'));
  }
  closeDb(db, file);
}
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail ? 1 : 0);
