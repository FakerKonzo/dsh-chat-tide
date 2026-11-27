// 设置开关：两个方向都生效（开→关 和 关→开）；关掉时不在 step 外写日志
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, l, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
  if (!c) fail++;
};

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

// 1) 两组钩子始终注册（不再用启动时的 if 包住）——这样即使启动时是关的，运行时打开也能生效
ok(!/if \(cfg\.features\.routing\) \{\s*ctx\.on\('agent\/pre-step'/.test(src), '路由钩子始终注册（不再被启动开关包住）');
ok(!/if \(cfg\.features\.contextInject\) \{/.test(src), '注入钩子始终注册（不再被启动开关包住）');
ok((src.match(/始终注册/g) || []).length >= 2, '两处都标注了「始终注册」');

// 2) 路由回调内读运行时开关
const routingIdx = src.indexOf("// ── 路由：一级标签");
const routingBlock = src.slice(routingIdx, routingIdx + 900);
ok(/features\?\.routing === false\) return next\(\)/.test(routingBlock), '路由：每步读当前设置，关掉直接放行');

// 3) 注入回调内读运行时开关 + 关掉时剔除记忆块
const injectIdx = src.indexOf("ctx.on('agent/pre-step'", src.indexOf('始终注册：开关在运行时读\n'));
const injectBlock = src.slice(injectIdx, src.indexOf('// step 已经开着', injectIdx));
ok(/const injectOn = effectiveCfg\(\)\.features\?\.contextInject !== false/.test(injectBlock), '注入：每轮读当前设置');
ok(/offMessages\.filter\(\(m\) => !isMemoryBlock\(m\)\)/.test(injectBlock), '注入：关掉时本轮消息剔除记忆块');

// 4) 关掉分支不能在 pre-step 里写 system/message（那会判会话损坏）
const offBlockStart = injectBlock.indexOf('if (!injectOn)');
const offBlock = injectBlock.slice(offBlockStart, offBlockStart + 900);
ok(!/retireMemoryNodes\(/.test(offBlock), '关掉分支不在 pre-step 写退役事件');
ok(/s2\.text = ''/.test(offBlock), '关掉分支只标记这一步清空，交由 step/start 处理');

// 5) step/start 仍是唯一退役时机
ok(/event\.type !== 'step\/start'/.test(src), '退役仍挂在 step/start');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
