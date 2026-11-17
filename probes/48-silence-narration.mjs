// 沉默只走工具，不靠猜正文
// 曾经试过用正则判定「整条只是括号/标点就丢掉」，那是在错误的层级打补丁：
// 决定沉默要么在上游闸门，要么由模型显式调用工具；正文一旦产出就不该被字符串猜疑。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SILENT_TOOL, createEgress, isSilentCall } from '../lib/egress.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// 1) 代码里不再有「猜正文」的函数
const egressSrc = read('../lib/egress.js');
ok(!/isNarrationOnly/.test(egressSrc), '出站不再按内容猜测旁白');
ok(!/\\p\{L\}/.test(egressSrc), '没有针对标点的正则判定');
ok(!/图跳过|图不看了/.test(egressSrc), '没有针对具体措辞的黑名单');
// 规则文件里保留「别用占位话」是行为要求，不是代码过滤

// 2) 沉默只认工具调用
ok(isSilentCall([SILENT_TOOL]) === true, '调用拒答工具即判静默');
ok(isSilentCall(['reply']) === false, '别的工具不算');
ok(isSilentCall([]) === false, '没调工具不算');

// 3) 行为：调了工具 → 正文丢弃；没调 → 原样放行（哪怕只有一个句号）
const collect = async (it) => {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
};
const egress = createEgress({ isBindable: () => true, cfg: {} });
const stream = (chunks) => (async function* () {
  for (const c of chunks) yield c;
})();

const silentChunks = [
  { type: 'text-delta', text: '这句不该出去' },
  { type: 'block-end', block: { type: 'text', text: '这句不该出去' } },
  { type: 'tool-call-delta', name: SILENT_TOOL },
];
const got = await collect(egress.wrapStream('s1', stream(silentChunks)));
ok(got.filter((c) => c.type === 'text-delta').length === 0, '调了工具，正文一个字节都不发');

const plainChunks = [
  { type: 'text-delta', text: '。' },
  { type: 'block-end', block: { type: 'text', text: '。' } },
];
const kept = await collect(egress.wrapStream('s1', stream(plainChunks)));
ok(kept.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') === '。', '没调工具就原样放行，不由框架替它猜');

// 4) 工具本身必须注册（这才是真正的修复点）
const idx = read('../lib/index.js');
ok(/if \(cfg\.features\.tools !== false\) \{[\s\S]{0,200}?name: 'stay_silent'/.test(idx), '拒答工具不看出站开关，始终注册');
ok(idx.includes('不想接话、不该插嘴'), '工具契约写明什么时候用它');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
