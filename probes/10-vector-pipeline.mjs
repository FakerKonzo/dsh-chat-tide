// 向量写入 + 余弦换算 + 路由判定 端到端（不依赖真模型，用确定性假向量）。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { ensureVecTables, loadVec, putVector, knn, distanceToCosine } from '../lib/vec.js';
import { appendEvent } from '../lib/events.js';
import { decideAmbient, actionFor } from '../lib/route.js';

const FILE = fileURLToPath(new URL('../.cache/probe-vecpipe.db', import.meta.url));
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

// 确定性单位向量：用词的字符和做种子
function fakeEmbed(text) {
  const v = new Float32Array(512);
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  for (let i = 0; i < 512; i++) v[i] = Math.sin((h + i) * 0.001) + (text.includes('杭州') ? (i < 8 ? 1 : 0) : 0);
  let n = 0;
  for (let i = 0; i < 512; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  for (let i = 0; i < 512; i++) v[i] /= n;
  return v;
}

// 1) 事实写入 + 向量写入 + KNN 自命中
const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
const f = writeFact(db, { ...base, canonicalKey: 'residence', value: '主人住在杭州' });
putVector(db, 'vec_fact', f.versionRowid, fakeEmbed('主人住在杭州'));
const self = knn(db, 'vec_fact', fakeEmbed('主人住在杭州'), 1);
ok(self.length === 1 && Math.abs(distanceToCosine(self[0].distance) - 1) < 1e-4, '向量自命中余弦≈1', JSON.stringify(self[0]));

// 2) 事件向量 + top1/top2 判定
const e1 = appendEvent(db, { eventId: 'ev1', eventType: 'conversation', content: '主人下周三去杭州出差', conversationKey: 'qq:g1' });
const r1 = db.prepare('SELECT rowid FROM event WHERE event_id=?').get(e1).rowid;
putVector(db, 'vec_event', r1, fakeEmbed('主人下周三去杭州出差'));
const e2 = appendEvent(db, { eventId: 'ev2', eventType: 'conversation', content: '今天群里在聊周末爬山', conversationKey: 'qq:g1' });
const r2 = db.prepare('SELECT rowid FROM event WHERE event_id=?').get(e2).rowid;
putVector(db, 'vec_event', r2, fakeEmbed('今天群里在聊周末爬山'));

const near = knn(db, 'vec_event', fakeEmbed('杭州那边怎么样'), 2);
const top1 = distanceToCosine(near[0].distance);
const top2 = distanceToCosine(near[1].distance);
ok(top1 > top2, '相近事件排前面', `top1=${top1.toFixed(3)} top2=${top2.toFixed(3)}`);
const verdict = decideAmbient({ top1, top2, high: 0.45, low: 0.3, marginThreshold: 0.03 });
console.log('  判定:', JSON.stringify(verdict), '动作:', actionFor(verdict.label));
ok(['relevant_ambient', 'uncertain', 'irrelevant_ambient'].includes(verdict.label), '判定返回合法标签');

// 3) 无关查询应得分更低
const far = knn(db, 'vec_event', fakeEmbed('完全不相关的句子'), 2);
if (far.length === 2) {
  const f1 = distanceToCosine(far[0].distance);
  ok(f1 <= top1 + 1e-6, '无关查询最高分不高于相关查询', `far=${f1.toFixed(3)}`);

// 4) 向量覆盖写后旧值不再命中
putVector(db, 'vec_event', r1, fakeEmbed('冬天去哈尔滨看雪'));
const after = knn(db, 'vec_event', fakeEmbed('主人下周三去杭州出差'), 5);
const stillOld = after.some((r) => Number(r.rowid) === Number(r1) && distanceToCosine(r.distance) > 0.999);
ok(!stillOld, '覆盖写后旧向量不再自命中');
}

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
