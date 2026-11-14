// 一次性跑完所有探针与一致性检查；CI 与本地共用。
// 用法：node scripts/run-checks.mjs [--skip-model]
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipModel = process.argv.includes('--skip-model') || process.env.CM_SKIP_MODEL === '1';

// 需要下载/加载向量模型的探针（CI 里默认跳过，避免依赖网络与 30MB 模型）
const MODEL_PROBES = new Set(['03-embedding.mjs', '14-embed-worker.mjs']);

const run = (file) => {
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
  return { ok: r.status === 0, tail, out };
};

const results = [];
const probes = readdirSync(join(root, 'probes')).filter((n) => n.endsWith('.mjs')).sort();
for (const name of probes) {
  if (skipModel && MODEL_PROBES.has(name)) {
    results.push({ name, ok: true, tail: 'SKIP（需要模型）' });
    continue;
  }
  const { ok, tail, out } = run(join('probes', name));
  // 能力探针（01–03）打印结论而非断言
  const printable = /^(01|02|03)-/.test(name);
  results.push({ name, ok: ok || printable, tail });
  if (!ok && !printable) console.log(out);
}

const checks = ['check-naming.mjs', 'check-dead-config.mjs', 'check-docs.mjs'];
for (const name of checks) {
  const { ok, tail, out } = run(join('scripts', name));
  results.push({ name: `scripts/${name}`, ok, tail });
  if (!ok) console.log(out);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(30)} ${r.tail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过${skipModel ? '（已跳过模型探针）' : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
