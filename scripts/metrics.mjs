import { defaultDbFile } from '../lib/const.js';
// 指标快照（只读）：按设计 §16.2 的口径，能从库里算的都算出来。
// 用法：node scripts/metrics.mjs
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLoadablePath } from 'sqlite-vec';

const dbFile = process.env.MEMORY_DB ?? defaultDbFile();
const db = new DatabaseSync(dbFile, { allowExtension: true });
try { db.loadExtension(getLoadablePath()); } catch { /* 向量不可用 */ }

const q = (sql, ...a) => {
  try {
    return db.prepare(sql).all(...a);
  } catch {
    return [];
  }
};
const one = (sql, ...a) => q(sql, ...a)[0] ?? {};

const route = q("SELECT content FROM event WHERE event_type='route_decision'");
const byLabel = {};
const byReason = {};
for (const r of route) {
  let c = {};
  try {
    c = JSON.parse(r.content ?? '{}');
  } catch {
    /* 旧记录没有内容 */
  }
  byLabel[c.label ?? 'unknown'] = (byLabel[c.label ?? 'unknown'] ?? 0) + 1;
  byReason[c.reason ?? 'unknown'] = (byReason[c.reason ?? 'unknown'] ?? 0) + 1;
}

const factByStatus = Object.fromEntries(q('SELECT status, count(*) c FROM fact GROUP BY status').map((r) => [r.status, r.c]));
const factByTier = Object.fromEntries(
  q("SELECT provenance_tier t, count(*) c FROM fact WHERE status='active' GROUP BY provenance_tier").map((r) => [r.t, r.c]),
);
const eventByType = Object.fromEntries(
  q("SELECT event_type t, count(*) c FROM event WHERE status='active' GROUP BY event_type").map((r) => [r.t, r.c]),
);
const observations = q("SELECT content, occurred_at FROM event WHERE event_type='observation' AND status='active' ORDER BY occurred_at DESC LIMIT 8");
const openConflicts = one("SELECT count(*) c FROM fact_conflict WHERE resolved=0").c ?? 0;
const pending = one("SELECT count(*) c FROM fact WHERE status='pending_confirmation'").c ?? 0;
const pendingVec = one('SELECT count(*) c FROM fact_version WHERE embedding_pending=1').c ?? 0;
const activeFacts = factByStatus.active ?? 0;
const vecFacts = (() => {
  try {
    return q(`SELECT count(*) c FROM fact f
      JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version
      WHERE f.status='active' AND EXISTS (SELECT 1 FROM vec_fact vv WHERE vv.rowid=v.rowid)`)[0]?.c ?? 'n/a';
  } catch {
    return 'n/a';
  }
})();

const injectFile = join(dirname(dbFile), 'inject.log');
let injects = [];
if (existsSync(injectFile)) {
  injects = readFileSync(injectFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
const injectByScope = {};
for (const i of injects) injectByScope[i.scope ?? '?'] = (injectByScope[i.scope ?? '?'] ?? 0) + 1;

console.log('== 数据 ==');
console.log('  事实', JSON.stringify(factByStatus), '按证据', JSON.stringify(factByTier));
console.log('  事件', JSON.stringify(eventByType), '开放冲突', openConflicts, '待确认', pending);
console.log('  向量覆盖', `${vecFacts}/${activeFacts}`, '积压', pendingVec);

console.log('\n== 路由（有记录时） ==');
console.log('  标签', JSON.stringify(byLabel));
console.log('  原因', JSON.stringify(byReason));
const budgetSkips = byReason.budget_skipped ?? 0;
const circuitSkips = byReason.circuit_open_skipped ?? 0;
console.log('  budget_skipped', budgetSkips, '/ circuit_open_skipped', circuitSkips, budgetSkips === 0 && circuitSkips === 0 ? '（都还没触发）' : '');

console.log('\n== 注入 ==');
console.log('  次数', injects.length, '按作用域', JSON.stringify(injectByScope));
if (injects.length) {
  const last = injects.at(-1);
  console.log('  最近一次', JSON.stringify(last));
}

console.log('\n== 最近经历 ==');
for (const o of observations) console.log('  -', new Date(o.occurred_at).toISOString().slice(0, 16).replace('T', ' '), String(o.content).slice(0, 60));

db.close();
