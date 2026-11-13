// 运维体检（只读）：对一个现有库跑完整性、一致性与健康度检查
// 用法：node scripts/doctor.mjs [--json]
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dbFile = process.env.MEMORY_DB ?? join(homedir(), '.dsh', 'chat-memory', 'memory.db');
const db = new DatabaseSync(dbFile, { allowExtension: true });
let vecReady = false;
try {
  db.loadExtension(getLoadablePath());
  vecReady = true;
} catch {
  vecReady = false;
}

const all = (sql, ...a) => {
  try {
    return db.prepare(sql).all(...a);
  } catch (e) {
    return [{ error: e.message }];
  }
};
const one = (sql, ...a) => all(sql, ...a)[0] ?? {};

const report = { dbFile, schema: null, checks: [] };
const check = (name, status, detail) => report.checks.push({ name, status, detail });

report.schema = one('PRAGMA user_version').user_version;

const integrity = one('PRAGMA integrity_check').integrity_check;
check('数据库完整性', integrity === 'ok' ? 'ok' : 'fail', integrity);
const fk = all('PRAGMA foreign_key_check').filter((r) => !r.error);
check('外键一致性', fk.length === 0 ? 'ok' : 'fail', fk.length);

const facts = one("SELECT count(*) c FROM fact WHERE status='active'").c;
const ftsFacts = one('SELECT count(*) c FROM fact_fts').c;
check('事实索引对齐', ftsFacts === facts ? 'ok' : 'warn', `${ftsFacts}/${facts}`);

const orphanVersions = one(
  `SELECT count(*) c FROM fact f WHERE f.status='active' AND NOT EXISTS (
     SELECT 1 FROM fact_version v WHERE v.fact_id=f.fact_id AND v.version=f.current_version AND v.status='active')`,
).c;
check('当前版本指针', orphanVersions === 0 ? 'ok' : 'fail', orphanVersions);

const pendingVec = one('SELECT count(*) c FROM fact_version WHERE embedding_pending=1').c;
check('向量积压', pendingVec === 0 ? 'ok' : 'warn', pendingVec);

if (vecReady) {
  const orphanFactVec = one(
    `SELECT count(*) c FROM vec_fact v WHERE NOT EXISTS (
       SELECT 1 FROM fact_version fv JOIN fact f ON f.fact_id=fv.fact_id AND f.current_version=fv.version
        WHERE fv.rowid=v.rowid AND f.status='active')`,
  ).c;
  check('孤儿事实向量', orphanFactVec === 0 ? 'ok' : 'warn', orphanFactVec);
  const orphanEventVec = one(
    `SELECT count(*) c FROM vec_event v WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.rowid=v.rowid AND e.status='active')`,
  ).c;
  check('孤儿事件向量', orphanEventVec === 0 ? 'ok' : 'warn', orphanEventVec);
  const attNoVec = one(
    `SELECT count(*) c FROM attention a WHERE a.status='active' AND NOT EXISTS (SELECT 1 FROM vec_attention v WHERE v.rowid=a.rowid)`,
  ).c;
  check('关注点缺向量', attNoVec === 0 ? 'ok' : 'warn', attNoVec);
}

// 隐私：长串标识不应出现在事实值与关注点里
const LONG_ID_RE = /\b[0-9A-Fa-f]{24,}\b/;
const factLeak = all("SELECT canonical_key k, v.value v FROM fact f JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version WHERE f.status='active' AND f.subtype <> 'rule'").filter(
  (r) => LONG_ID_RE.test(String(r.k ?? '') + ' ' + String(r.v ?? '')),
);
check('事实标识泄漏', factLeak.length === 0 ? 'ok' : 'fail', factLeak.length);
const attLeak = all("SELECT label, note FROM attention WHERE status='active'").filter((r) =>
  LONG_ID_RE.test(String(r.label ?? '') + ' ' + String(r.note ?? '')),
);
check('关注点标识泄漏', attLeak.length === 0 ? 'ok' : 'fail', attLeak.length);

const pendConf = one("SELECT count(*) c FROM fact WHERE status='pending_confirmation'").c;
check('待确认事实', pendConf === 0 ? 'ok' : 'info', pendConf);
const openConflict = one('SELECT count(*) c FROM fact_conflict WHERE resolved=0').c;
check('未解决冲突', openConflict === 0 ? 'ok' : 'warn', openConflict);
const deletedNoAudit = one(
  "SELECT count(*) c FROM fact f LEFT JOIN tombstone t ON t.target_id=f.fact_id AND t.target_type='fact' WHERE f.status='deleted' AND t.target_id IS NULL",
).c;
check('删除缺审计', deletedNoAudit === 0 ? 'ok' : 'info', deletedNoAudit);

report.totals = {
  facts,
  rules: one("SELECT count(*) c FROM fact WHERE status='active' AND subtype='rule'").c,
  events: one("SELECT count(*) c FROM event WHERE status='active' AND event_type='observation'").c,
  attention: one("SELECT count(*) c FROM attention WHERE status='active'").c,
  people: one('SELECT count(*) c FROM people').c,
  images: one('SELECT count(*) c FROM image_cache').c,
  candidates: one('SELECT count(*) c FROM topic_candidate').c,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('库文件', dbFile);
  console.log('schema', report.schema);
  console.log('');
  for (const c of report.checks) console.log(`[${c.status}] ${c.name}: ${JSON.stringify(c.detail)}`);
  console.log('');
  console.log('统计', JSON.stringify(report.totals));
}
db.close();
const bad = report.checks.filter((c) => c.status === 'fail').length;
process.exit(bad === 0 ? 0 : 1);