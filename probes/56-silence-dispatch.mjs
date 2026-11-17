// 拒答要能被任何调用链路认出来：直接调、或包在 run_code 里
import { createEgress, SILENT_TOOL } from '../lib/egress.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const collect = async (it) => {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
};
const stream = (chunks) => (async function* () { for (const c of chunks) yield c; })();

// 1) 声明静默之后，后续流的正文必须被丢掉（不依赖这次流的工具名）
const eg = createEgress({ isBindable: () => true, cfg: {} });
eg.declareSilent('s1');
const chunks = [
  { type: 'text-delta', text: '不该出去' },
  { type: 'block-end', block: { type: 'text', text: '不该出去' } },
];
const out = await collect(eg.wrapStream('s1', stream(chunks)));
ok(out.filter((c) => c.type === 'text-delta').length === 0, '已声明静默的会话，正文被丢弃');
const end = out.find((c) => c.type === 'block-end');
ok(end?.block?.text === '', '文本块被清空');

// 2) 没声明时照常放行
const eg2 = createEgress({ isBindable: () => true, cfg: {} });
const kept = await collect(eg2.wrapStream('s2', stream(chunks)));
ok(kept.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') === '不该出去', '没声明就原样发');

// 3) 换轮次后状态清空：turn/start 会重置
const eg3 = createEgress({ isBindable: () => true, cfg: {} });
eg3.declareSilent('s3');
eg3.observe('s3', { type: 'turn/start', data: { turn: 2 } });
const after = await collect(eg3.wrapStream('s3', stream(chunks)));
ok(after.filter((c) => c.type === 'text-delta').length === 1, '新的一轮不再继承静默');
ok(SILENT_TOOL === 'stay_silent', '工具名没变');
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
