// 主进程兜底默认关闭：模型拉不起来时必须明说，且不能把 onnxruntime 拖进宿主进程
// 原因：主进程加载 onnxruntime 后原生库被占住，卸载插件会删不掉文件，插件页升级卡在「移除旧插件」。
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getEmbedder, resetEmbedder } from '../lib/embed.js';

const EMPTY = fileURLToPath(new URL('../.cache/probe-no-model/', import.meta.url));
rmSync(EMPTY, { recursive: true, force: true });

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 空缓存 + 禁联网 + 不显式要求兜底：快速失败，给明确原因
const t0 = Date.now();
const e = await getEmbedder({ cacheDir: EMPTY, allowRemote: false });
const ms = Date.now() - t0;
ok(e.ready === false, '模型缺失时不报就绪');
ok(ms < 15000, '失败要快，不要卡在下载重试上', `${ms}ms`);
ok(typeof e.error === 'string' && e.error.includes('向量模型不可用'), '错误信息说清是模型不可用');
ok(e.error.includes('allowInline'), '错误信息指出兜底开关');
ok(!e.error.includes('\n'), '错误信息只有一行，不带堆栈');
ok(e.embed === null, '不可用时不给 embed');

// 2) 配置默认值：兜底是关的、联网是开的（config.js 依赖宿主包，这里看源码）
const cfgSrc = readFileSync(fileURLToPath(new URL('../lib/config.js', import.meta.url)), 'utf8');
ok(/allowInline:\s*z\.boolean\(\)\.default\(false\)/.test(cfgSrc), '配置默认关闭主进程兜底');
ok(/allowRemote:\s*z\.boolean\(\)\.default\(true\)/.test(cfgSrc), '配置默认允许联网下载');
ok(/allowInline/.test(cfgSrc) && /allowRemote/.test(cfgSrc), '两个开关都在配置里声明');

resetEmbedder();
rmSync(EMPTY, { recursive: true, force: true });
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
