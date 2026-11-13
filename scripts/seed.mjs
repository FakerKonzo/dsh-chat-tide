// 预置导入：把 presets/ 下的规则与关注点灌进现有库（幂等，默认只补缺）
// 用法：node scripts/seed.mjs [--rules] [--attention] [--private] [--force]
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { addAttention, listAttention } from '../lib/attention.js';

const root = fileURLToPath(new URL('../presets/', import.meta.url));
const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const wantAll = !args.has('--rules') && !args.has('--attention') && !args.has('--private');

// 防手滑：不指定分类时，必须显式确认才动真实库
const dbFile = process.env.MEMORY_DB ?? defaultDbFile();
const liveDb = dbFile.includes('.dsh');
if (wantAll && liveDb && !args.has('--i-know')) {
  console.error('拒绝执行：这会往线上库写入预置。请加 --rules/--attention/--private 之一，或加 --i-know 明确确认。');
  process.exit(2);
}

const db = openDatabase(dbFile);

function existingRule(key) {
  return db
    .prepare("SELECT fact_id AS id FROM fact WHERE status='active' AND canonical_key=? AND subtype='rule'")
    .get(key);
}

function seedRules(file, label) {
  if (!existsSync(file)) return { added: 0, skipped: 0 };
  const { rules } = readJson(file);
  let added = 0;
  let skipped = 0;
  for (const r of rules ?? []) {
    if (!r?.key || !r?.value) continue;
    const hit = existingRule(r.key);
    if (hit && !force) {
      skipped++;
      continue;
    }
    writeFact(db, {
      userId: 'system',
      entityId: 'system',
      assertedBy: 'seed',
      subjectId: 'system',
      canonicalKey: r.key,
      subtype: 'rule',
      value: r.value,
      provenanceTier: 'source_verifiable',
      scope: 'unknown',
    });
    added++;
  }
  console.log(`${label}: 新增 ${added}，跳过已存在 ${skipped}`);
  return { added, skipped };
}

function seedAttention(file) {
  if (!existsSync(file)) return 0;
  const { attention } = readJson(file);
  const have = new Set(listAttention(db, { limit: 200 }).map((a) => a.label));
  let added = 0;
  for (const a of attention ?? []) {
    if (!a?.label || have.has(a.label)) continue;
    addAttention(db, { kind: 'topic', label: a.label, weight: a.weight ?? 0.5, ttlDays: a.ttlDays ?? 30 });
    added++;
  }
  console.log(`关注点: 新增 ${added}`);
  return added;
}

if (wantAll || args.has('--rules')) seedRules(`${root}rules/generic.json`, '通用规则');
if (wantAll || args.has('--private')) seedRules(`${root}private.json`, '私人规则');
if (wantAll || args.has('--attention')) seedAttention(`${root}attention/example.json`);

console.log('规则总数', db.prepare("SELECT count(*) c FROM fact WHERE status='active' AND subtype='rule'").get().c);
console.log('关注点总数', listAttention(db, { limit: 200 }).length);
db.close();