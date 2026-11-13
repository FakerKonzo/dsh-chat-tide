// 接茬概率自测：顺序是「兜底判相关 → L2 初筛 → 掷骰子」
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { screenAgainstL2, shouldReplyToAmbient } from '../lib/ambient.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 直接消息不走概率
ok(shouldReplyToAmbient({ label: 'direct', probability: 0 }).reply === true, 'direct 永不因概率被拦');
ok(shouldReplyToAmbient({ label: 'command', probability: 0 }).reason === 'not-ambient', 'command 不走概率');

// 2) 概率关
ok(shouldReplyToAmbient({ label: 'ambient', probability: 0, l2: { hit: true } }).reason === 'probability-off', '概率 0 时全部不接');

// 3) 未过 L2 初筛 → 不接（即使概率 1）
ok(shouldReplyToAmbient({ label: 'ambient', probability: 1, l2: { hit: false } }).reply === false, 'L2 未命中：概率 1 也不接');
ok(shouldReplyToAmbient({ label: 'ambient', probability: 1, l2: { hit: false } }).reason === 'no-l2-overlap', '原因标 no-l2-overlap');

// 4) 过 L2 初筛 → 概率 1 必接
ok(shouldReplyToAmbient({ label: 'ambient', probability: 1, l2: { hit: true } }).reply === true, 'L2 命中 + 概率 1：必接');

// 5) L2 命中后按概率掷
let hits = 0;
for (let i = 0; i < 1000; i++) {
  if (shouldReplyToAmbient({ label: 'ambient', probability: 0.1, l2: { hit: true } }).reply) hits++;
}
ok(hits > 60 && hits < 140, '概率 0.1 时命中率约 10%', `${hits}/1000`);
ok(shouldReplyToAmbient({ label: 'ambient', probability: 0.1, l2: { hit: true }, random: () => 0.05 }).reply === true, '注入随机 0.05 时接');
ok(shouldReplyToAmbient({ label: 'ambient', probability: 0.1, l2: { hit: true }, random: () => 0.5 }).reply === false, '注入随机 0.5 时不接');

// 6) L2 初筛本身
const near = { factId: 'f1', vec: Float32Array.from([1, 0, 0]) };
const far = { factId: 'f2', vec: Float32Array.from([0, 1, 0]) };
ok(screenAgainstL2([1, 0, 0], [], 0.5).hit === false, '空输入安全');
ok(screenAgainstL2([1, 0, 0], [near, far], 0.5).hit === true, '余弦 1 过阈值');
ok(screenAgainstL2([1, 0, 0], [near, far], 0.5).factId === 'f1', '命中最近的 f1');
ok(screenAgainstL2([0, 1, 0], [near], 0.5).hit === false, '正交余弦 0 不过阈值');
ok(screenAgainstL2([1, 0, 0], [], 0.5).hit === false, '无事实时不过');
const q = Float32Array.from([0.7071, 0.7071, 0]);
ok(screenAgainstL2(q, [near], 0.6).hit === true, '余弦 0.707 过 0.6 阈值', screenAgainstL2(q, [near], 0.6).score.toFixed(3));

// 7) 与库联调：写入事实后初筛能命中
const FILE = fileURLToPath(new URL('../.cache/probe-ambient.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
const f = writeFact(db, { ...base, canonicalKey: 'solar_project', value: '屋顶光伏方案', surface: '屋顶光伏那件事' });
const row = db.prepare('SELECT rowid FROM fact_version WHERE fact_id=? AND version=?').get(f.factId, f.version);
ok(typeof row.rowid === 'number' || typeof row.rowid === 'bigint', '新事实有可向量化 rowid');
db.close();

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
