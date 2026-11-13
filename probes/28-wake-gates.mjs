// 唤醒闸门自测：静默时段、每日上限、最小间隔
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { ensureVecTables, loadVec, putVector } from '../lib/vec.js';
import { appendEvent } from '../lib/events.js';
import { decideRoute, inQuietHours, wakeStats } from '../lib/route-decision.js';

const FILE = fileURLToPath(new URL('../.cache/probe-gates.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const vecOk = loadVec(db);
if (vecOk) ensureVecTables(db);

// 静默时段
const at = (h, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
ok(inQuietHours(at(3), { quietEnabled: true, quietStart: '00:00', quietEnd: '08:00' }) === true, '凌晨在静默时段');
ok(inQuietHours(at(3), { quietEnabled: false }) === false, '开关关闭时不静默');
ok(inQuietHours(at(12), { quietEnabled: true, quietStart: '00:00', quietEnd: '08:00' }) === false, '中午不在静默时段');
ok(inQuietHours(at(23), { quietEnabled: true, quietStart: '22:00', quietEnd: '06:00' }) === true, '跨零点区间');

// 唤醒统计
ok(wakeStats(db, Date.now()).count === 0, '初始无接茬记录');
appendEvent(db, { eventId: 'w1', eventType: 'route_decision', content: JSON.stringify({ label: 'relevant_ambient', reason: 'attention-hit' }), conversationKey: 'qq:g1', occurredAt: Date.now() });
ok(wakeStats(db, Date.now()).count === 1, '统计到 1 次接茬');
ok(wakeStats(db, Date.now()).lastAt > 0, '记录最近一次时间');

// 造一个必然相关的事实
const DIM = 512;
const mk = (i) => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};
if (vecOk) {
  putVector(db, 'vec_fact', 1, mk(0));
  db.prepare(
    `INSERT INTO fact(fact_id,user_id,entity_id,canonical_key,subtype,status,current_version,provenance_tier,updated_at)
     VALUES ('f1','u1','u1','pref.owner.x','preference','active',1,'human_explicit',?)`,
  ).run(Date.now());
  db.prepare("INSERT INTO fact_version(fact_id,version,value,status,created_at) VALUES ('f1',1,'测试','active',?)").run(Date.now());
}
const embedder = vecOk ? { embed: async () => [mk(0)] } : null;

const cfg = {
  routing: {
    high: 0.55, low: 0.42, margin: 0.02, uncertainPolicy: 'reject', budget: 100000,
    llmFallback: false, exemplarThreshold: 0.5, ambientReplyProbability: 1,
    quietEnabled: true, quietStart: '00:00', quietEnd: '23:59', maxWakesPerDay: 0, minWakeIntervalMinutes: 0,
    ftsRescue: true, l2Threshold: 0.45,
  },
  attention: { enabled: false },
};
const binding = { adapter: 'qq', scope: 'group', peerId: 'g1', conversationKey: 'qq:g1' };
const base = { db, cfg, binding, text: '测试一句话', embedder, vecReady: vecOk, random: () => 0 };

const r0 = await decideRoute({ ...base, cfg: { ...cfg, routing: { ...cfg.routing, quietEnabled: false } }, now: at(12) });
ok(r0.action === 'wake', '无闸门时应唤醒（前置校验）', r0.reason);
if (r0.action !== 'wake') {
  console.log('  跳过后续闸门断言（前置校验失败）');
} else {
  const r1 = await decideRoute({ ...base, now: at(3) });
  ok(r1.reason === 'quiet-hours', '静默时段被拦', r1.reason);

  const cfgCap = { ...cfg, routing: { ...cfg.routing, quietEnabled: false, maxWakesPerDay: 1 } };
  const r2 = await decideRoute({ ...base, cfg: cfgCap, now: at(12) });
  ok(r2.reason === 'daily-cap', '达到每日上限被拦', r2.reason);

  const cfgGap = { ...cfg, routing: { ...cfg.routing, quietEnabled: false, maxWakesPerDay: 0, minWakeIntervalMinutes: 30 } };
  const r3 = await decideRoute({ ...base, cfg: cfgGap, now: Date.now() });
  ok(r3.reason === 'cooldown', '冷却期内被拦', r3.reason);
}

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
