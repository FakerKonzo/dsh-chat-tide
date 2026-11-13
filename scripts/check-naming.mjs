// 名称一致性检查：唯一来源之外的散落字面量、客户端 BASE、样式前缀
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE, API_BASE, DATA_DIRNAME, DB_FILENAME, LOG_CLIENT_LOAD, LOG_PAGE_ERROR, STYLE_PREFIX } from '../lib/const.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 常量自洽
ok(ROUTE === `/${'tide'}`, '路由与行 id 一致', ROUTE);
ok(API_BASE === `${ROUTE}/api`, 'API 前缀由路由派生', API_BASE);
ok(DATA_DIRNAME === 'tide' && DB_FILENAME === 'memory.db', '数据目录与库文件名', `${DATA_DIRNAME}/${DB_FILENAME}`);
ok(LOG_CLIENT_LOAD === 'client-load.log' && LOG_PAGE_ERROR === 'page-error.log', '日志文件名');
ok(STYLE_PREFIX === 'tide', '样式前缀', STYLE_PREFIX);

// 2) 客户端 BASE 必须等于服务端 API 前缀（客户端是独立 bundle，不能 import）
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const baseMatch = /const BASE = '([^']+)'/.exec(client);
ok(baseMatch?.[1] === API_BASE, '客户端 BASE 与 API 前缀一致', baseMatch?.[1]);

// 3) 服务端文件里不应再有散落的路由/库名/日志名（const.js 与文档注释除外）
const offenders = [];
for (const name of readdirSync(join(root, 'lib'))) {
  if (!name.endsWith('.js') || name === 'const.js' || name === 'client.js') continue;
  const text = readFileSync(join(root, 'lib', name), 'utf8');
  for (const [needle, allow] of [
    ["'/tide/api", false],
    ['memory.db', name === 'config.js'],
    ['client-load.log', false],
    ['page-error.log', false],
  ]) {
    if (!allow && text.includes(needle)) offenders.push(`${name}: ${needle}`);
  }
}
ok(offenders.length === 0, '无散落硬编码名称', JSON.stringify(offenders));

// 4) 样式前缀统一
ok(!/\bcm-/.test(client), '客户端无旧样式前缀');
const status = readFileSync(join(root, 'lib', 'status-page.js'), 'utf8');
ok(!/cm-/.test(status), '状态页无旧样式前缀');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
