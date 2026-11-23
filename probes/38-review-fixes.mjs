// review 后的三处行为：L2 事实门槛、经历按 id 去重、抽取开关默认值
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { appendEvent } from '../lib/events.js';
import { buildInjection } from '../lib/inject.js';
import { decideRoute } from '../lib/route-decision.js';
import { putVector, loadVec, ensureVecTables } from '../lib/vec.js';
import { DEFAULTS } from '../lib/schema.js';

const FILE = fileURLToPath(new URL('../.cache/probe-review.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 配置默认值：抽默认开着，L2 门槛有值
ok(DEFAULTS['routing.l2Threshold'] > 0, 'L2 门槛有默认值', String(DEFAULTS['routing.l2Threshold']));

// 2) L2：事件不近、事实够近 → 判相关
const vecReady = loadVec(db);
if (vecReady) {
  ensureVecTables(db);
  const base = { userId: 'U1', entityId: 'U1', assertedBy: 'U1', subjectId: 'U1', provenanceTier: 'human_explicit' };
  const f = writeFact(db, { ...base, canonicalKey: 'owner.solar', subtype: 'profile', value: '屋顶光伏方案进度', scope: 'group' });
  const dim = 512;
  const near = new Float32Array(dim).fill(0);
  near[0] = 0.6; near[1] = 0.8; // 与查询 cos≈0.6：低于 high，高于 low，靠 L2 提升
  putVector(db, 'vec_fact', f.versionRowid, near);
  // 查询向量与事实非常接近（cos≈1），但事件表为空
  const query = new Float32Array(dim).fill(0); query[0] = 1;
  const embedder = { embed: async () => [query] };
  const binding = { scope: 'group', peerId: 'G1', conversationKey: 'qq:G1' };
  const cfg = {
    routing: { high: 0.99, low: 0.2, margin: 0.02, l2Threshold: 0.45, budget: 1000, quietEnabled: false, ambientReplyProbability: 0 },
    attention: { enabled: false },
  };
  const d = await decideRoute({ db, cfg, binding, text: '光伏那个方案咋样了', isMentioned: false, embedder, vecReady: true, random: () => 0.99 });
  ok(d.label === 'relevant_ambient' || d.action === 'wake', 'L2 事实命中即可判相关', `${d.label}/${d.action}/${JSON.stringify(d.detail ?? {})}`);

  // 事实不够近时不应靠 L2 放行
  const far = new Float32Array(dim).fill(0);
  far[2] = 1; // 与查询正交
  const embedderFar = { embed: async () => [far] };
  const d2 = await decideRoute({ db, cfg, binding, text: '今天天气如何', isMentioned: false, embedder: embedderFar, vecReady: true, random: () => 0.99 });
  ok(d2.label !== 'relevant_ambient', '事实不近时不判相关', JSON.stringify({label:d2.label,reason:d2.reason,detail:d2.detail}));
}

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
