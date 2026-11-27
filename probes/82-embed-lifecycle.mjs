// embedding 子进程：卸载时释放、崩溃后可重建、熔断器真正接线
import { readFileSync } from 'node:fs';
import { createCircuit } from '../lib/circuit.js';

let fail = 0;
const ok = (c, l, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
  if (!c) fail++;
};
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

// 1) 卸载时释放
ok(/import \{ getEmbedder, resetEmbedder \} from '\.\/embed\.js'/.test(src), '引入了 resetEmbedder');
ok(/ctx\.effect\(\(\) => \(\) => \{[\s\S]{0,120}resetEmbedder\(\)/.test(src), '卸载 effect 里调用 resetEmbedder（释放子进程）');

// 2) 可重建：把加载抽成 startEmbedder，且崩溃后重新调用
ok(/const startEmbedder = \(\) =>/.test(src), 'embedding 加载抽成 startEmbedder()');
ok(/void startEmbedder\(\);/.test(src), '启动时调用 startEmbedder()');
ok(/resetEmbedder\(\);[\s\S]{0,120}embedder = null;[\s\S]{0,120}void startEmbedder\(\)/.test(src), '崩溃后 reset + 重新加载');

// 3) 熔断器接线：失败/成功都记
ok(/embedCircuit\.recordFailure\('embed'\)/.test(src), 'embed 失败记 recordFailure');
ok(/embedCircuit\.recordSuccess\('embed'\)/.test(src), 'embed 成功记 recordSuccess');

// 4) 熔断器语义（真实模块）：连续失败到阈值后打开，冷却后恢复
const now = { t: 1000 };
const cb = createCircuit({ threshold: 3, cooldownMs: 1000, now: () => now.t });
ok(cb.isOpen('embed') === false, '熔断：初始关闭');
cb.recordFailure('embed');
cb.recordFailure('embed');
cb.recordFailure('embed');
ok(cb.isOpen('embed') === true, '熔断：连续 3 次失败后打开');
now.t += 1001;
ok(cb.isOpen('embed') === false, '熔断：冷却后可再试');
cb.recordSuccess('embed');
cb.recordFailure('embed');
cb.recordFailure('embed');
ok(cb.isOpen('embed') === false, '熔断：成功会清计数');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
