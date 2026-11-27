// 出站流：普通回复顺序不变；正文 + 拒答工具同一步时发出去的是零字；关掉 hold 就直通
import { createEgress } from '../lib/egress.js';

let fail = 0;
const ok = (c, l, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
  if (!c) fail++;
};
const collect = async (it) => {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
};
const src = (chunks) => (async function* () { for (const c of chunks) yield c; })();

// ── A：普通回复（不静默）顺序完全不变 ──
const eA = createEgress({ isBindable: () => true, cfg: { holdTextOnSilence: true }, log: () => {} });
const chunksA = [
  { type: 'text-delta', text: 'a' },
  { type: 'text-delta', text: 'b' },
  { type: 'block-end', block: { type: 'text', text: 'ab' } },
  { type: 'block-end', block: { type: 'tool-call', name: 'search' } },
  { type: 'finish' },
];
const outA = await collect(eA.wrapStream('s1', src(chunksA), { gate: true }));
ok(outA.length === chunksA.length, 'A：块数一致', String(outA.length));
ok(outA.map((c) => c.type).join(',') === chunksA.map((c) => c.type).join(','), 'A：顺序与原始一致', outA.map((c) => c.type).join(','));
ok(outA[2].block.text === 'ab', 'A：正文没被清空');

// ── B：正文 + stay_silent 同一步 → 零字 ──
const eB = createEgress({ isBindable: () => true, cfg: { holdTextOnSilence: true }, log: () => {} });
const chunksB = [
  { type: 'text-delta', text: '不该发出去的正文' },
  { type: 'block-end', block: { type: 'text', text: '不该发出去的正文' } },
  { type: 'tool-call-delta', name: 'stay_silent' },
  { type: 'block-end', block: { type: 'tool-call', name: 'stay_silent' } },
];
const outB = await collect(eB.wrapStream('s2', src(chunksB), { gate: true }));
const textOut = outB.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
const endText = outB.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text).join('');
ok(textOut === '', 'B：没有正文增量发出', JSON.stringify(textOut));
ok(endText === '', 'B：文本块被清空', JSON.stringify(endText));
ok(outB.some((c) => c.type === 'block-end' && c.block?.type === 'tool-call'), 'B：工具块仍在（不影响静默本身）');

// ── C：holdTextOnSilence=false → 直通，不包装、不改顺序 ──
const eC = createEgress({ isBindable: () => true, cfg: { holdTextOnSilence: false }, log: () => {} });
const input = src(chunksB);
const returned = eC.wrapStream('s3', input, { gate: true });
ok(returned === input, 'C：关掉 hold 时原样返回（不缓冲、不改顺序）');

// ── D：不动他人会话（未绑定）直接放行 ──
const eD = createEgress({ isBindable: () => false, cfg: { holdTextOnSilence: true }, log: () => {} });
const inD = src(chunksB);
ok(eD.wrapStream('other', inD, { gate: true }) === inD, 'D：非本插件会话不碰流');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
