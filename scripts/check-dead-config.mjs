// 死配置扫描：config.js 里声明的键，有没有被真正读取
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const libDir = join(root, 'lib');
const configText = readFileSync(join(libDir, 'config.js'), 'utf8');

// 取出 schema 里声明的键：形如 foo: z.boolean() / nested: { ... }
const keys = [...configText.matchAll(/^\s{4,8}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1]);
const unique = [...new Set(keys)];

const sources = readdirSync(libDir)
  .filter((f) => f.endsWith('.js') && f !== 'config.js')
  .map((f) => ({ f, text: readFileSync(join(libDir, f), 'utf8') }));

const unused = [];
for (const key of unique) {
  // 任何位置的点访问都算（含 cfg.write?.key 这类可选链）
  const re = new RegExp('\\.' + key + '\\b');
  const hit = sources.some(({ text }) => re.test(text));
  if (!hit) unused.push(key);
}

console.log('声明键', unique.length, '个');
console.log('未被读取', unused.length, unused.join(', ') || '（无）');
