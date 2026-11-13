// decideRoute 端到端自测：策略/禁言/预算/熔断/向量/概率 全链路（假嵌入，不联网）
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { ensureVecTables, loadVec, putVector } from '../lib/vec.js';
import { writeFact } from '../lib/facts.js';
import { appendEvent } from '../lib/events.js';
import { setSilence, setRoutePolicy } from '../lib/silence.js';
import { decideRoute } from '../lib/route-decision.js';
import { addAttention, matchAttention } from '../lib/attention.js';

const FILE = fileURLToPath(new URL('../.cache/probe-decision.db', import.meta.url));
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

const binding = { adapter: 'qq', scope: 'group', peerId: 'g1', conversationKey: 'qq:g1' };
const cfg = {
  routing: { high: 0.55, low: 0.42, margin: 0.02, uncertainPolicy: 'reject', budget: 1000, llmFallback: false, exemplarThreshold: 0.5, ambientReplyProbability: 1, l2Threshold: 0.4 },
};

// 造一条与查询同向的向量（事实 + 事件）
const DIM = 512;
const mk = (i) => { const v = new Float32Array(DIM); v[i] = 1; return v; };
const V = mk(0);
const embedder = { embed: async () => [V] };
putVector(db, 'vec_fact', 1, V);
db.prepare(
  `INSERT INTO fact(fact_id,user_id,entity_id,canonical_key,subtype,status,current_version,provenance_tier,updated_at)
   VALUES ('f1','u1','u1','solar_project','profile','active',1,'human_explicit',?)
   ON CONFLICT(fact_id) DO NOTHING`,
).run(Date.now());
db.prepare(
  `INSERT INTO fact_version(fact_id,version,value,status,created_at) VALUES ('f1',1,'屋顶光伏方案','active',?)`,
).run(Date.now());
appendEvent(db, { eventId: 'e1', eventType: 'observation', content: '今天聊了屋顶光伏', conversationKey: 'qq:g1', occurredAt: Date.now() });
db.prepare('UPDATE event SET status=\'active\' WHERE event_id=\'e1\'').run();

const base = { db, cfg, binding, text: '那个方案怎么样了', embedder, vecReady: true, random: () => 0.1 };

// 0) 关注点：把方案事实标为我在意的事
const attId = addAttention(db, { kind: 'fact', refId: 'f1', label: '屋顶光伏方案', weight: 0.8 });
ok(!!attId, '关注点写入', String(attId));
ok(matchAttention(db, '屋顶光伏方案怎么样了')?.label === '屋顶光伏方案', '文本命中关注点');

// 1) direct 直接放行
const d = await decideRoute({ ...base, text: '小黑在吗 (@you)', isMentioned: true });
ok(d.action === 'wake' && d.label === 'direct', 'direct 直接唤醒', JSON.stringify(d.label));

// 2) 私聊不过滤：c2c 一律放行（即使文本是闲聊、概率 0）
const rC2c = await decideRoute({ ...base, binding: { ...binding, scope: 'c2c', peerId: 'p1', conversationKey: 'qq:p1' }, cfg: { ...cfg, routing: { ...cfg.routing, ambientReplyProbability: 0 } } });
ok(rC2c.action === 'wake' && rC2c.reason === 'private-chat', '私聊直接放行', JSON.stringify({ a: rC2c.action, r: rC2c.reason }));

// 3) 无关闲聊 → 低分 → reject（探索概率即使 1 也不接）
const far = { embed: async () => [mk(1)] };
const r2 = await decideRoute({ ...base, embedder: far });
ok(r2.action === 'reject', '无关闲聊被拒', JSON.stringify(r2.label + '/' + r2.reason));

// 3) 相关 + 概率 1 → 唤醒
const r3 = await decideRoute({ ...base, random: () => 0.1 });
console.log('   相关样例决策:', JSON.stringify({ action: r3.action, label: r3.label, reason: r3.reason, top1: r3.detail.top1?.toFixed(3), factTop1: r3.detail.factTop1?.toFixed(3) }));
ok(['wake', 'reject'].includes(r3.action), '相关样例返回合法动作');
console.log('   动作原因:', r3.reason);

// 4) 概率 0 → 必拒（即使相关）
const noAtt = { enabled: false };
const cfg0 = { ...cfg, attention: noAtt, routing: { ...cfg.routing, ambientReplyProbability: 0 } };
const r4 = await decideRoute({ ...base, cfg: cfg0 });
ok(r4.action === 'reject' && r4.reason === 'explore-off', '探索概率 0 必拒', r4.reason);

// 5) 禁言 → 拒
setSilence(db, { scopeId: 'g1' });
const r5 = await decideRoute({ ...base });
ok(r5.action === 'reject' && r5.reason === 'silenced', '禁言期间不接', r5.reason);

// 6) 策略 direct_only → 拒
setRoutePolicy(db, { conversationKey: 'qq:g1', mode: 'direct_only', ttlMs: 60000 });
const r6 = await decideRoute({ ...base });
ok(r6.action === 'reject' && r6.reason === 'policy-drop', '策略拦截', r6.reason);

// 7) 熔断 → 拒
const r7 = await decideRoute({ ...base, circuitOpen: true, binding: { ...binding, peerId: 'g2', conversationKey: 'qq:g2' } });
ok(r7.action === 'reject' && r7.reason === 'circuit_open_skipped', '熔断跳过', r7.reason);

// 8) 预算耗尽 → 拒
const tiny = { ...cfg, routing: { ...cfg.routing, budget: 0 } };
const r8 = await decideRoute({ ...base, cfg: tiny, binding: { ...binding, peerId: 'g3', conversationKey: 'qq:g3' } });
ok(r8.action === 'reject' && r8.reason === 'budget_skipped', '预算跳过', r8.reason);

// 8.9) 关注点命中直接唤醒（不掷骰子）
const bAtt = { ...binding, peerId: 'g5', conversationKey: 'qq:g5' };
const rAtt = await decideRoute({ ...base, binding: bAtt, random: () => 0.999 });
ok(rAtt.action === 'wake' && rAtt.reason === 'attention-hit', '关注点命中直接唤醒', JSON.stringify({ a: rAtt.action, r: rAtt.reason }));

// 9) 强制唤醒窗口：相关消息跳过概率（random 0.99 也不会 miss）
const cfgF = { ...cfg, attention: noAtt, routing: { ...cfg.routing, forceWakeUntil: Date.now() + 60000 } };
const b4 = { ...binding, peerId: 'g4', conversationKey: 'qq:g4' };
const rf = await decideRoute({ ...base, binding: b4, cfg: cfgF, random: () => 0.99 });
ok(rf.action === 'wake' && rf.detail.gate === 'forced', '窗口内强制唤醒', JSON.stringify({ a: rf.action, g: rf.detail.gate }));
const cfgE = { ...cfg, attention: noAtt, routing: { ...cfg.routing, ambientReplyProbability: 0.1, forceWakeUntil: Date.now() - 1000 } };
const re = await decideRoute({ ...base, binding: b4, cfg: cfgE, random: () => 0.99 });
ok(re.action === 'reject' && re.reason === 'explore-miss', '窗口过期后按探索概率拒', re.reason);

// 10) 嵌入失败 → 不抛，走 uncertain 路径
const bad = { embed: async () => { throw new Error('boom'); } };
const r9 = await decideRoute({ ...base, embedder: bad });
ok(typeof r9.action === 'string', '嵌入失败不抛', r9.action);

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
