// 文档一致性：路由、数据目录、配置键、默认值、探针数
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE, API_BASE, DATA_DIRNAME, DB_FILENAME, LOG_CLIENT_LOAD, LOG_PAGE_ERROR, STYLE_PREFIX } from '../lib/const.js';
import { DEFAULTS } from '../lib/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const md = read('README.md');
const docsAll = [md, read('CONTRIBUTING.md'), read('RELEASE.md')].join('\n');
const config = read('lib/config.js');
const consts = read('lib/const.js');

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 路由与数据目录
ok(docsAll.includes('/tide'), '文档里提到 /tide 路由');
ok(!/\/chat-memory/.test(md), 'README 无旧路由');
ok(docsAll.includes('.dsh/tide') || docsAll.includes('~/.dsh/tide'), '文档里的数据目录是 tide');

// 2) 配置示例里的键必须在 config.js 里存在
const fences = [...md.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)].map((m) => m[1]);
const yaml = fences.filter((b) => /^\s*\w+:/m.test(b) && !/^\s*(npm|node|git|cd|pnpm)/m.test(b)).join('\n');
const declared = new Set([...config.matchAll(/^\s{2,10}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1]));
const nested = new Set([...config.matchAll(/^\s{6,12}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1]));
const usedKeys = [...yaml.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
const unknown = [...new Set(usedKeys)].filter((k) => !declared.has(k) && !nested.has(k));
ok(unknown.length === 0, 'README 配置示例的键都在配置里', JSON.stringify(unknown));

// 3) 文档里不该出现本机绝对路径与个人工作区
const hostPaths = [...md.matchAll(/[A-Z]:\\[^\s`)]+/g)].map((m) => m[0]);
ok(hostPaths.length === 0, 'README 无本机绝对路径', JSON.stringify(hostPaths));
ok(!/cd works\//.test(md), 'README 不写个人工作区路径');

// 4) README 表格里写的默认值必须与 schema 一致
const tableRows = [...md.matchAll(/^\| `([a-z.]+)` \| ([^|]+?) \|/gm)].map((m) => [m[1], m[2].trim()]);
const drift = [];
for (const [key, shown] of tableRows) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
  const want = String(DEFAULTS[key]).replace(/\s+/g, '');
  const got = shown.replace(/\s+/g, '');
  if (got !== want) drift.push(key + ': README ' + shown + ' ≠ 代码 ' + DEFAULTS[key]);
}
ok(drift.length === 0, 'README 默认值与代码一致', JSON.stringify(drift));

// 5) 探针数量（README 若写了数字）
const probeCount = readdirSync(join(root, 'probes')).filter((n) => n.endsWith('.mjs')).length;
const claimed = /(\d+)\s*(?:个)?探针|(\d+)\s+probes/.exec(md);
if (claimed) {
  const n = Number(claimed[1] ?? claimed[2]);
  ok(n === probeCount, 'README 探针数与实际一致', `${n} vs ${probeCount}`);
}

// 6) const.js 是唯一来源
ok(/ROUTE = '\/tide'/.test(consts), 'const.js 路由为 /tide');
ok(/DATA_DIRNAME = 'tide'/.test(consts), 'const.js 数据目录为 tide');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
