// 修复工具：区间引用（含被拒的）、image/offload 的 imageIndexes 逐张校验
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
let fail = 0;
const ok = (c, l, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
  if (!c) fail++;
};
const header = JSON.stringify({ type: 'session', version: 4, id: 'probe77', createdAt: 1, cwd: '/x' });
const script = fileURLToPath(new URL('../scripts/repair-session-log.mjs', import.meta.url));

function writeLog(path, events) {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, Buffer.concat([zstdCompressSync(Buffer.from(header + '\n')), zstdCompressSync(Buffer.from(body))]));
}
function readEvents(path) {
  const buf = readFileSync(path);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let i = 0;
  while (true) {
    const m = buf.indexOf(magic, i);
    if (m < 0) break;
    starts.push(m);
    i = m + 1;
  }
  starts.push(buf.length);
  const lines = [];
  for (let k = 0; k < starts.length - 1; k++) for (const l of zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])).toString().split('\n')) if (l.trim()) lines.push(l);
  return lines.slice(1).map((l) => JSON.parse(l));
}
const run = (path) => {
  try {
    return { out: execFileSync(process.execPath, [script, path, '--write'], { encoding: 'utf8' }), failed: false };
  } catch (err) {
    return { out: String(err.stdout || '') + String(err.stderr || ''), failed: true };
  }
};
const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };

// ── A：非法事件排在图前面，图片消息与 image/offload 的 seq 一起前移，imageIndexes 保留且仍指向图片 ──
const a = join(CACHE, 'p77-a.zstd');
rmSync(a, { force: true });
writeLog(a, [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } }, // 非法
  { seq: 4, type: 'user/message', time: 5, data: { role: 'user', content: [IMG, IMG] } },
  { seq: 5, type: 'image/offload', time: 6, data: { targets: [{ seq: 4, imageIndexes: [1] }] } },
  { seq: 6, type: 'turn/end', time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
]);
const ra = run(a);
ok(!ra.failed && /已修复/.test(ra.out), 'A：user/message 第二张图的重定位修复成功', ra.out.trim().split('\n').pop());
const evA = readEvents(a);
const offA = evA.find((e) => e.type === 'image/offload');
ok(offA?.data?.targets?.[0]?.seq === 3, 'A：targets.seq 重排为 3', String(offA?.data?.targets?.[0]?.seq));
ok(JSON.stringify(offA?.data?.targets?.[0]?.imageIndexes) === '[1]', 'A：imageIndexes 原样保留', JSON.stringify(offA?.data?.targets?.[0]?.imageIndexes));
rmSync(a, { force: true });

// ── B：索引指向的不是图片（只有一张图却引用第二张）→ 必须拒绝 ──
const b = join(CACHE, 'p77-b.zstd');
rmSync(b, { force: true });
writeLog(b, [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  { seq: 4, type: 'user/message', time: 5, data: { role: 'user', content: [IMG] } },
  { seq: 5, type: 'image/offload', time: 6, data: { targets: [{ seq: 4, imageIndexes: [1] }] } }, // 越界
  { seq: 6, type: 'turn/end', time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
]);
const rb = run(b);
ok(rb.failed, 'B：引用不存在的图片时拒绝写入');
rmSync(b, { force: true });

// ── C：图片来自工具结果也允许 ──
const c = join(CACHE, 'p77-c.zstd');
rmSync(c, { force: true });
writeLog(c, [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  { seq: 4, type: 'tool/result', time: 5, data: { turn: 1, step: 1, message: { role: 'tool', content: [IMG] } } },
  { seq: 5, type: 'image/offload', time: 6, data: { targets: [{ seq: 4, imageIndexes: [0] }] } },
  { seq: 6, type: 'turn/end', time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
]);
const rc = run(c);
ok(!rc.failed && /已修复/.test(rc.out), 'C：工具结果里的图片修复成功', rc.out.trim().split('\n').pop());
rmSync(c, { force: true });

// ── D：sourceEventSeqs 用区间 [[0,2]]，三条都保留 → 必须接受 ──
const d = join(CACHE, 'p77-d.zstd');
rmSync(d, { force: true });
writeLog(d, [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  { seq: 4, type: 'user/message', time: 5, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, sourceEventSeqs: [[0, 2]] },
  { seq: 5, type: 'turn/end', time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
]);
const rd = run(d);
ok(!rd.failed && /已修复/.test(rd.out), 'D：区间引用 [[0,2]] 全部保留时修复成功', rd.out.trim().split('\n').pop());
if (!rd.failed) {
  const evD = readEvents(d);
  const u = evD.find((e) => e.type === 'user/message');
  ok(JSON.stringify(u?.sourceEventSeqs) === '[[0,2]]', 'D：区间引用保留', JSON.stringify(u?.sourceEventSeqs));
}
rmSync(d, { force: true });

// ── E：区间端点指向被删事件 → 拒绝 ──
const e2 = join(CACHE, 'p77-e.zstd');
rmSync(e2, { force: true });
writeLog(e2, [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  // 区间 [[2,4]] 覆盖 2、3、4；其中 3 是被删的非法 system/message
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  { seq: 4, type: 'user/message', time: 5, data: { role: 'user', content: [{ type: 'text', text: 'x' }] }, sourceEventSeqs: [[2, 4]] },
  { seq: 5, type: 'turn/end', time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
]);
const re = run(e2);
ok(re.failed, 'E：区间端点落在被删事件上时拒绝写入');
rmSync(e2, { force: true });

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
