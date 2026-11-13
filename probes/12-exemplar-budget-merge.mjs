// 示例库 / 预算 / 多跳合并 / 冲突整理 自测。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { ensureVecTables, loadVec, putVector, knn, distanceToCosine } from '../lib/vec.js';
import { addExemplar, listExemplars, matchExemplar, removeExemplar } from '../lib/exemplar.js';
import { consumeBudget, peekBudget, pruneBudgets } from '../lib/budget.js';
import { mergeCandidates, mergeByKey, renderMerged } from '../lib/merge.js';
import { listOpenConflicts, resolveConflict } from '../lib/conflict.js';

const FILE = fileURLToPath(new URL('../.cache/probe-v3.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// ── 示例库 ──
const a1 = addExemplar(db, { text: '小黑在吗', label: 'relevant_ambient' });
const a2 = addExemplar(db, { text: 'a', label: 'bogus' });
ok(a1.ok === true, '示例入库');
ok(a2.ok === false, '非法标签拒绝入库');
ok(listExemplars(db).length === 1, '只列已审核示例');
ok(removeExemplar(db, a1.exemplarId).removed === true, '示例删除');

// ── 预算（固定窗口） ──
const t0 = 1_700_000_000_000;
const b1 = consumeBudget(db, 'qq:g1', { budget: 2, now: t0 });
const b2 = consumeBudget(db, 'qq:g1', { budget: 2, now: t0 + 1000 });
const b3 = consumeBudget(db, 'qq:g1', { budget: 2, now: t0 + 2000 });
ok(b1.allowed && b2.allowed && !b3.allowed, '预算超限被拒', JSON.stringify([b1.spent, b2.spent, b3.spent]));
ok(peekBudget(db, 'qq:g1', { now: t0 + 2000 }).spent === 2, '窗口内花费可读');
const b4 = consumeBudget(db, 'qq:g1', { budget: 2, now: t0 + 10 * 60_000 });
ok(b4.allowed === true && b4.spent === 1, '跨窗口重新计数');
ok(pruneBudgets(db, { now: t0 + 60 * 60_000, keepWindows: 1 }).pruned === 2, '过期窗口被清理');

// ── 多跳合并 ──
const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
const f1 = writeFact(db, { ...base, canonicalKey: 'residence', value: '杭州', provenanceTier: 'human_explicit', occurredAt: t0 });
writeFact(db, { ...base, canonicalKey: 'residence', value: '上海', provenanceTier: 'human_explicit', occurredAt: t0 + 86_400_000 });
const rows = db
  .prepare(
    `SELECT f.canonical_key AS canonicalKey, f.status, f.current_version AS version, f.provenance_tier AS tier,
            f.occurred_at AS occurredAt, v.value
       FROM fact f JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version
      WHERE f.canonical_key='residence'`,
  )
  .all();
const merged = mergeCandidates(rows);
ok(merged.primary?.value === '上海', '同键取最新', JSON.stringify(merged.primary?.value));
const pendRow = db.prepare(`SELECT f.canonical_key AS canonicalKey, f.status, f.current_version AS version, f.provenance_tier AS tier, f.occurred_at AS occurredAt, v.value FROM fact f JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version WHERE f.canonical_key='residence' OR f.canonical_key='job'`).all();
const merged2 = mergeCandidates([...rows, { ...rows[0], status: 'pending_confirmation', value: '北京', tier: 'agent_inferred', occurredAt: t0 + 2 * 86_400_000 }]);
ok(merged2.alternatives.length >= 1, '其余进 alternatives', JSON.stringify(merged2.alternatives.map(a=>a.value)));
const multi = mergeByKey({ residence: rows, unknown: [] });
ok(multi.length === 2 && multi[1].primary === null, '多键批量合并');
ok(renderMerged(multi).includes('上海'), '合并结果可渲染');

// ── 冲突整理 ──
const pend = writeFact(db, { ...base, canonicalKey: 'pet', value: '养猫', occurredAt: t0 + 5 * 86_400_000 });
writeFact(db, { ...base, canonicalKey: 'pet', value: '养狗', provenanceTier: 'agent_inferred', occurredAt: t0 + 6 * 86_400_000 });
const open = listOpenConflicts(db);
ok(open.length >= 1, '未解决冲突可列', `n=${open.length}`);
const target = open[0];
const res = resolveConflict(db, target.conflictId, { keep: 'a', by: 'manual' });
ok(res.ok === true, '冲突落定', JSON.stringify(res));
ok(listOpenConflicts(db).length === open.length - 1, '落定后不再出现在未解决列表');
void f1;
void pend;

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
