// 熔断自测。
import { createCircuit } from '../lib/circuit.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

let t = 1000;
const c = createCircuit({ threshold: 3, cooldownMs: 10_000, now: () => t });

ok(c.isOpen('embed') === false, '初始关闭');
c.recordFailure('embed');
c.recordFailure('embed');
ok(c.isOpen('embed') === false, '未达阈值仍关闭');
c.recordFailure('embed');
ok(c.isOpen('embed') === true, '连续失败达阈值 → 打开');

t += 5000;
ok(c.isOpen('embed') === true, '冷却期内保持打开');
t += 6000;
ok(c.isOpen('embed') === false, '冷却结束转半开放行');
ok(c.snapshot('embed').failures === 0, '半开时清零失败计数');

c.recordSuccess('embed');
ok(c.isOpen('embed') === false && c.snapshot('embed').failures === 0, '成功即关闭');

c.recordFailure('other');
ok(c.isOpen('other') === false && c.isOpen('embed') === false, '不同名字互不影响');

c.recordFailure('embed');
c.recordFailure('embed');
c.recordFailure('embed');
ok(c.isOpen('embed') === true, '再次连续失败可重新打开', JSON.stringify(c.snapshot('embed')));
t += 11_000;
ok(c.isOpen('embed') === false, '再次冷却后转半开');
c.recordFailure('embed');
c.recordFailure('embed');
ok(c.isOpen('embed') === false, '半开未达阈值仍放行');
c.recordFailure('embed');
ok(c.isOpen('embed') === true, '半开后再达阈值重新打开');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
