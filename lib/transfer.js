// 配置导入导出与整库备份。
// 导入只碰设置和规矩：记忆、审计、原始日志一概不动。

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { DEFAULTS } from './schema.js';
import { DB_FILENAME } from './const.js';
import { getOverrides, setOverride, isKnownKey } from './settings.js';
import { writeFact } from './facts.js';

/** 校验一份导入文件是不是我们认识的形状。 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not-an-object' };
  const kind = raw.kind;
  if (kind !== undefined && kind !== 'tide-config') return { ok: false, error: 'wrong-kind' };
  if (kind === 'tide-config' && raw.version !== undefined && raw.version > 1) {
    return { ok: false, error: 'newer-format' };
  }
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  const unknownKeys = Object.keys(settings).filter((k) => !isKnownKey(k));
  return { ok: true, settings, rules, unknownKeys };
}

/** 只看差异：哪些设置会变、哪些规矩是新增的。 */
export function planImport(db, raw) {
  const norm = normalizeConfig(raw);
  if (!norm.ok) return norm;
  const current = getOverrides(db);
  const settings = [];
  for (const [key, value] of Object.entries(norm.settings)) {
    if (!isKnownKey(key)) continue; // 旧版本或别的插件留下的键，跳过
    const from = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : DEFAULTS[key];
    if (String(from) === String(value)) continue;
    settings.push({ key, from, to: value });
  }
  const existing = new Map(
    db
      .prepare(
        `SELECT f.canonical_key AS k, v.value AS v FROM fact f
           JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version
          WHERE f.status='active' AND f.subtype='rule'`,
      )
      .all()
      .map((r) => [r.k, r.v]),
  );
  const rules = { added: [], updated: [], same: 0 };
  for (const r of norm.rules) {
    const key = String(r?.key ?? '').trim();
    if (!key) continue;
    const appliesTo = String(r?.appliesTo ?? 'any');
    if (!existing.has(key)) rules.added.push({ key, value: r.value, appliesTo });
    else if (String(existing.get(key)) !== String(r.value)) rules.updated.push({ key, value: r.value, appliesTo });
    else rules.same += 1;
  }
  return { ok: true, kind: 'tide-import-plan', settings, rules, skippedKeys: norm.unknownKeys };
}

/**
 * 应用导入。assertRule 由调用方注入，用来复用抽取侧的规矩准入
 * （非主人身份、未知身份都不该借导入把规矩塞进来）。
 */
export function applyImport(db, plan, { assertRule } = {}) {
  if (!plan?.ok) return plan;
  const applied = { settings: 0, rules: 0, rejected: [] };
  for (const item of plan.settings) {
    const r = setOverride(db, item.key, item.to);
    if (r.ok) applied.settings += 1;
    else applied.rejected.push({ key: item.key, error: r.error });
  }
  for (const item of [...plan.rules.added, ...plan.rules.updated]) {
    const gate = assertRule ? assertRule(item.key, item.value) : { ok: true };
    if (!gate.ok) {
      applied.rejected.push({ key: item.key, error: gate.error });
      continue;
    }
    const r = writeFact(db, {
      userId: 'system',
      entityId: 'system',
      assertedBy: 'import',
      subjectId: 'system',
      canonicalKey: item.key,
      subtype: 'rule',
      value: item.value,
      appliesTo: item.appliesTo ?? 'any',
      provenanceTier: 'source_verifiable',
    });
    if (r?.outcome) applied.rules += 1;
  }
  return { ok: applied.rejected.length === 0, ...applied };
}

/** 规矩只接受 rule.* 键，值必须是非空字符串。 */
export function assertRuleInput(key, value) {
  if (!/^rule\./.test(String(key ?? ''))) return { ok: false, error: 'not-a-rule-key' };
  if (!String(value ?? '').trim()) return { ok: false, error: 'empty-value' };
  return { ok: true };
}

/**
 * 一致性备份：VACUUM INTO 会把 WAL 里已提交但未合并的内容一起写进快照。
 * 生成后立刻只读打开校验完整性和条数，通过才交出去。
 */
export function createBackup(db, { dir } = {}) {
  const base = dir ?? tmpdir();
  const workDir = mkdtempSync(join(base, 'tide-backup-'));
  const out = join(workDir, DB_FILENAME);
  try {
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    return { ok: false, error: `vacuum-failed:${String(err?.message ?? err)}` };
  }
  let check;
  let copy = null;
  try {
    copy = new DatabaseSync(out, { readOnly: true });
    const integrity = copy.prepare('PRAGMA integrity_check').get();
    const facts = copy.prepare("SELECT count(*) c FROM fact WHERE status='active'").get().c;
    const events = copy.prepare("SELECT count(*) c FROM event WHERE status='active'").get().c;
    check = { integrity: Object.values(integrity ?? {})[0], facts, events };
  } catch (err) {
    try {
      copy?.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(workDir, { recursive: true, force: true });
    return { ok: false, error: `verify-failed:${String(err?.message ?? err)}` };
  }
  try {
    copy?.close();
  } catch {
    /* 已关闭 */
  }
  if (String(check.integrity) !== 'ok') {
    rmSync(workDir, { recursive: true, force: true });
    return { ok: false, error: `integrity:${check.integrity}` };
  }
  const size = statSync(out).size;
  if (!size) {
    rmSync(workDir, { recursive: true, force: true });
    return { ok: false, error: 'empty-backup' };
  }
  return { ok: true, path: out, dir: workDir, size, facts: check.facts, events: check.events };
}
