// 生成可安装包：把 lib/ + 清单拷到 pkg/（去掉探针、node_modules、缓存）。
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'pkg');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'lib'), join(out, 'lib'), { recursive: true });
cpSync(join(root, 'cordis.patch.yml'), join(out, 'cordis.patch.yml'));
cpSync(join(root, 'README.md'), join(out, 'README.md'));
cpSync(join(root, 'README.en.md'), join(out, 'README.en.md'));
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(root, 'presets'), join(out, 'presets'), { recursive: true });
// 私人规则绝不进安装包
rmSync(join(out, 'presets', 'private.json'), { force: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// 只保留 test，方便安装后自检
if (pkg.scripts?.test) pkg.scripts = { test: pkg.scripts.test }; else delete pkg.scripts;
delete pkg.devDependencies;
pkg.description = 'Tide — chat memory and selective waking for DSH (installable package)';
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// 客户端 bundle 的注册 id 必须等于包名：不一致会让宿主重复注册同名工厂，启动直接失败
const client = readFileSync(join(out, 'lib', 'client.js'), 'utf8');
const idMatch = /^\s*id:\s*'([^']+)'/m.exec(client);
if (!idMatch) throw new Error('client.js 没有找到注册 id');
if (idMatch[1] !== pkg.name) {
  throw new Error(`client 注册 id (${idMatch[1]}) 与包名 (${pkg.name}) 不一致，先改 lib/client.js`);
}

console.log('packed ->', out);
