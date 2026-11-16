// 插件不自己配 provider/model：抽取跟着会话当前用的模型走
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const cfgSrc = read('../lib/config.js');
const idxSrc = read('../lib/index.js');
const patch = read('../cordis.patch.yml');

// 1) 配置里不再有抽取模型这一项
ok(!/extract:\s*z\.object\(\{[\s\S]{0,200}?provider:/.test(cfgSrc), '配置里没有 extract.provider');
ok(!/extract:\s*z\.object\(\{[\s\S]{0,200}?model:\s*z\.string/.test(cfgSrc), '配置里没有 extract.model');

// 2) 运行时不读 extract.provider / extract.model
ok(!/cfg\.extract\.provider/.test(idxSrc), '代码不读 cfg.extract.provider');
ok(!/cfg\.extract\.model/.test(idxSrc), '代码不读 cfg.extract.model');

// 3) 用会话的模型选择
ok(idxSrc.includes('payload?.modelSelection'), '从 pre-step 取会话模型');
ok(/modelBySession\.set\(sessionId, sel\)/.test(idxSrc), '按会话记住模型选择');
ok(/makeComplete\(ctx, sessionModel\)/.test(idxSrc), '轮末抽取用该会话的模型');
ok(/reasoningEffort: sel\.reasoningEffort/.test(idxSrc), '思考档位一并沿用，不自造');

// 4) 拿不到模型就不抽取，不猜默认值
ok(/if \(!sel\?\.provider \|\| !sel\?\.model\) return ''/.test(idxSrc), '没有模型选择就不发请求');

// 5) 出厂补丁不再写死 provider/model
ok(!/extract:[\s\S]{0,80}provider:/.test(patch), '出厂补丁里没有 extract.provider');
ok(!/extract:[\s\S]{0,80}model:/.test(patch), '出厂补丁里没有 extract.model');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
