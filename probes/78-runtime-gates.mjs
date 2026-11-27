// 设置页的开关必须当场生效：关掉就不再用旧值
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 用文本检查而不是真的起插件：确认回调里读的是运行时设置，不是启动时的静态值
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

// 1) contextInject：pre-step 回调里必须有运行时判断
const injectBlock = src.slice(src.indexOf("ctx.on('agent/pre-step'"), src.indexOf('// step 已经开着'));
ok(/const injectOn = effectiveCfg\(\)\.features\?\.contextInject !== false/.test(injectBlock), '注入：每轮读一次当前设置');
ok(/retireMemoryNodes\(session, stale, turn, step/.test(injectBlock), '注入：关掉时把还生效的旧块退役');
ok(/messageNodes|isMemoryBlock/.test(injectBlock) && /filter\(\(m\) => !isMemoryBlock\(m\)\)/.test(injectBlock), '注入：关掉时从本轮消息里剔除记忆块');

// 2) routing：回调内先判开关
const routingBlock = src.slice(src.indexOf("// ── 路由：一级标签"), src.indexOf('// ── 路由：一级标签') + 1200);
ok(/features\?\.routing === false\) return next\(\)/.test(routingBlock), '路由：每步先判开关，关掉直接放行');

// 3) egressGate：关掉时不包装流
ok(/features\?\.egressGate === false\) return iter/.test(src), '出站：开关关闭时不包装流（不攒文本块）');

// 4) 静态兜底仍在：启动时挂不挂钩子这件事没被破坏
ok(/if \(cfg\.features\.routing\)/.test(src) && /if \(cfg\.features\.contextInject\)/.test(src), '启动时的静态判断仍在（只在启动读一次也不影响运行时开关）');

// 5) 关掉注入时，宿主送去模型的那份 messages 里不能再有记忆块
//    这里只验代码路径：pre-step 在 injectOn=false 时把 isMemoryBlock 的条目过滤掉
ok(
  /const offMessages = offDecision\?\.messages \?\? \[\];/.test(src) &&
    /offMessages\.filter\(\(m\) => !isMemoryBlock\(m\)\)/.test(src),
  '注入：关掉后本轮消息里不含记忆块',
);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
