// embedding 子进程：卸载时释放、崩溃后可重建、熔断器真正接线
import { getEmbedder, resetEmbedder } from '../lib/embed.js';
import { createCircuit } from '../lib/circuit.js';

let fail = 0;
const ok = (c, l, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
  if (!c) fail++;
};
// 两个等待者共用一次加载，卸载在 ready 之前也会唤醒所有等待者。
const opts = { allowRemote: false };
const a = getEmbedder(opts);
const b = getEmbedder(opts);
resetEmbedder();
const [first, second] = await Promise.all([a, b]);
ok(first === second && !first.ready && /cancelled/.test(first.error), '加载期间卸载，共用的加载任务结束');
const later = await getEmbedder({ useChild: false, allowInline: false });
ok(!later.ready && later !== first && !/cancelled/.test(later.error), '卸载后可以发起独立加载');
resetEmbedder();

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
