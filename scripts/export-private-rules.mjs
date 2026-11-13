// 从当前库导出生僻（私人）规则到 presets/private.json（不入库）
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { defaultDbFile } from '../lib/const.js';

const root = fileURLToPath(new URL('../presets/', import.meta.url));
const generic = JSON.parse(readFileSync(root + 'rules/generic.json', 'utf8'));
const genericKeys = new Set(generic.rules.map((r) => r.key));

const db = openDatabase(process.env.MEMORY_DB ?? defaultDbFile());
const rows = db
  .prepare(
    `SELECT f.canonical_key AS k, v.value AS val
       FROM fact f JOIN fact_version v ON v.fact_id = f.fact_id AND v.version = f.current_version
      WHERE f.status = 'active' AND f.subtype = 'rule' AND f.canonical_key NOT IN (${[...genericKeys].map(() => '?').join(',')})
      ORDER BY f.canonical_key`,
  )
  .all(...genericKeys);

writeFileSync(
  root + 'private.json',
  JSON.stringify(
    {
      version: 1,
      description: 'Deployment-specific rules. Gitignored; never publish this file.',
      rules: rows.map((r) => ({ key: r.k, value: r.val })),
    },
    null,
    2,
  ) + '\n',
);
console.log('导出私人规则', rows.length, '条 → presets/private.json');
console.log(rows.map((r) => r.k).join(', '));
db.close();