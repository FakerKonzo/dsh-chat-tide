// 作用域 off 时，/tide 与 /tide/api/* 仍要注册（否则设置页 404）
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, l, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
  if (!c) fail++;
};
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

// 1) 早退之前定义了可复用的注册器
const regIdx = src.indexOf('const registerStatusPage');
const offIdx = src.indexOf("=== 'off'");
ok(regIdx > 0 && regIdx < offIdx, '注册器定义在作用域 off 早退之前');

// 2) off 分支里确实调用了注册器
const offBlock = src.slice(offIdx, offIdx + 400);
ok(/registerStatusPage\(looseOwnerInfo\)/.test(offBlock), 'off 分支注册了状态页（带只读 owner 信息）');
ok(/return;/.test(offBlock), 'off 分支仍在注册之后返回（不加载工具/钩子）');

// 3) 正常路径复用同一个注册器，且只有一处注册
const regCalls = (src.match(/registerStatusPage\(/g) || []).length;
ok(regCalls >= 2, '注册器在 off 与正常路径各调用一次', String(regCalls));
ok((src.match(/webServer\.register\(/g) || []).length === 1, 'webServer.register 只有一处（在注册器里）');

// 4) 路径仍是 /tide 前缀
ok(/path: ROUTE/.test(src) && /import \{ ROUTE,[^}]*\} from '.\/const.js'/.test(src), '路由前缀用 ROUTE 常量');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
