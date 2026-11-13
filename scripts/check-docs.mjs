// README 与代码一致性检查：路由、数据目录、配置键、命令路径
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const md = read('README.md');
const config = read('lib/config.js');
const consts = read('lib/const.js');

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 路由与数据目录
ok(md.includes('/tide'), 'README 提到 /tide');
ok(!/chat-memory/i.test(md), 'README 无旧命名');
ok(md.includes('.dsh/tide') || md.includes('~/.dsh/tide'), 'README 的数据目录是 tide', (md.match(/\.dsh\/[a-z-]+/g) ?? []).join(','));

// 2) 配置示例里的键必须在 config.js 里存在
const fences = [...md.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)].map((m) => m[1]);
const yaml = fences.filter((b) => /^\s*\w+:/m.test(b) && !/^\s*(npm|node|git|cd|pnpm)/m.test(b)).join('\n');
const declared = new Set([...config.matchAll(/^\s{2,10}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1]));
const nested = new Set([...config.matchAll(/^\s{6,12}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1]));
const usedKeys = [...yaml.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
const unknown = [...new Set(usedKeys)].filter((k) => !declared.has(k) && !nested.has(k));
ok(unknown.length === 0, 'README 配置示例的键都在配置里', JSON.stringify(unknown));

// 3) 文档里不该出现本机绝对路径
const hostPaths = [...md.matchAll(/[A-Z]:\\[^\s`)]+/g)].map((m) => m[0]);
ok(hostPaths.length === 0, 'README 无本机绝对路径', JSON.stringify(hostPaths));

// 4) 命令行里的仓库路径应是通用写法
ok(!/cd works\//.test(md), 'README 不写个人工作区路径', (md.match(/cd works\/\S+/g) ?? []).join(','));

// 5) const.js 是唯一来源
ok(/ROUTE = '\/tide'/.test(consts), 'const.js 路由为 /tide');
ok(/DATA_DIRNAME = 'tide'/.test(consts), 'const.js 数据目录为 tide');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
