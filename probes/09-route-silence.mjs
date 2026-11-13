// 路由/静默/策略自测。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { classify, decideAmbient, actionFor, budgetGate } from '../lib/route.js';
import {
  activePolicies,
  activeSilence,
  applyPolicies,
  clearSilence,
  reapExpiredPolicies,
  setRoutePolicy,
  setSilence,
  MAX_POLICY_MS,
} from '../lib/silence.js';

const FILE = fileURLToPath(new URL('../.cache/probe-route.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 标签
ok(classify({ text: '你好', isMentioned: true }) === 'direct', '被 @ → direct');
ok(classify({ text: '/new' }) === 'command', '斜杠命令 → command');
ok(classify({ text: '今天天气不错' }) === 'ambient', '普通群消息 → ambient');
ok(classify({ text: 'x', isSystem: true }) === 'noise', '系统消息 → noise');

// 2) 阈值判定
const hi = decideAmbient({ top1: 0.62, top2: 0.4, high: 0.5, low: 0.35, marginThreshold: 0.03 });
ok(hi.label === 'relevant_ambient', '高分高 margin → 相关', JSON.stringify(hi));
const lo = decideAmbient({ top1: 0.2, top2: 0.18, high: 0.5, low: 0.35 });
ok(lo.label === 'irrelevant_ambient', '低分 → 不相关');
const mid = decideAmbient({ top1: 0.45, top2: 0.44, high: 0.5, low: 0.35, marginThreshold: 0.03 });
ok(mid.label === 'uncertain', '灰区 → uncertain');
ok(actionFor('uncertain') === 'reject', 'uncertain 默认 reject');
ok(actionFor('relevant_ambient') === 'wake', 'related 唤醒');
ok(actionFor('noise') === 'reject', 'noise 不唤醒');

// 3) 预算与熔断分开
ok(budgetGate({ spent: 10, budget: 5 }).reason === 'budget_skipped', '预算跳过单独标注');
ok(budgetGate({ spent: 0, budget: 5, circuitOpen: true }).reason === 'circuit_open_skipped', '熔断跳过单独标注');

// 4) B 禁言：设置 / 生效 / 到期自失效
const s = setSilence(db, { scopeId: 'g1', expiresAt: Date.now() + 60_000 });
ok(activeSilence(db, { scopeId: 'g1' })?.silenceId === s.silenceId, '禁言生效');
const s2 = setSilence(db, { scopeId: 'g1', expiresAt: Date.now() + 120_000 });
ok(s2.silenceId === s.silenceId && s2.updated === true, '重复请求幂等（延长同一记录）');
db.prepare('UPDATE silence SET expires_at=? WHERE silence_id=?').run(Date.now() - 1, s.silenceId);
ok(activeSilence(db, { scopeId: 'g1' }) === null, '到期自动失效');
setSilence(db, { scopeId: 'g2' });
ok(clearSilence(db, { scopeId: 'g2' }).cleared === true, '解除禁言');
ok(activeSilence(db, { scopeId: 'g2' }) === null, '解除后不再生效');

// 5) C 临时覆盖：上限钳制 / 到期自取消
const p1 = setRoutePolicy(db, { conversationKey: 'qq:g1', mode: 'no_ambient', ttlMs: 99 * 3_600_000 });
ok(p1.ok && p1.clampedMs === MAX_POLICY_MS, '有效期被钳到硬上限', JSON.stringify(p1.clampedMs));
ok(activePolicies(db, 'qq:g1').length === 1, '策略生效');
ok(applyPolicies(activePolicies(db, 'qq:g1'), 'ambient') === 'drop', 'no_ambient 丢环境消息');
ok(applyPolicies(activePolicies(db, 'qq:g1'), 'direct') === 'pass', 'direct 仍放行');
db.prepare('UPDATE route_policy SET expires_at=? WHERE policy_id=?').run(Date.now() - 1, p1.policyId);
const reaped = reapExpiredPolicies(db);
ok(reaped.length === 1 && activePolicies(db, 'qq:g1').length === 0, '到期自取消');
const p2 = setRoutePolicy(db, { conversationKey: 'qq:g1', mode: 'direct_only', ttlMs: 60_000 });
ok(applyPolicies(activePolicies(db, 'qq:g1'), 'ambient') === 'drop', 'direct_only 丢环境消息');
ok(applyPolicies(activePolicies(db, 'qq:g1'), 'command') === 'pass', 'direct_only 放行命令');
void p2;

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
