// 修复工具必须重映射所有 SessionSeq 引用（含 developer/message.headerSeq）
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const file = join(CACHE, 'probe-repair-tool.zstd');
rmSync(file, { force: true });

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const header = JSON.stringify({ type: 'session', version: 4, id: 'probe-repair', createdAt: 1, cwd: '/x' });
const ev = [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  // 非法：step 已关，写 system/message
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  { seq: 4, type: 'step/start', time: 5, data: { turn: 1, step: 2 } },
  { seq: 5, type: 'request/header', time: 6, data: { header: { config: {}, tools: [] }, reason: 'start' } },
  {
    seq: 6,
    type: 'developer/message',
    time: 7,
    // headerSeq 指向 seq5 的 request/header；删掉 seq3 后必须跟着减 1
    data: { turn: 1, step: 2, message: { role: 'developer', content: [{ type: 'text', text: 'x' }] }, headerSeq: 5 },
  },
  { seq: 7, type: 'step/end', time: 8, data: { turn: 1, step: 2 } },
  { seq: 8, type: 'turn/end', time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
];

const body = ev.map((e) => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(
  file,
  Buffer.concat([zstdCompressSync(Buffer.from(header + '\n', 'utf8')), zstdCompressSync(Buffer.from(body, 'utf8'))]),
);

const script = fileURLToPath(new URL('../scripts/repair-session-log.mjs', import.meta.url));
let out = '';
try {
  out = execFileSync(process.execPath, [script, file, '--write'], { encoding: 'utf8' });
} catch (err) {
  ok(false, '修复脚本执行成功', String(err.stdout || err.message));
}
ok(/已修复/.test(out), '脚本报告已修复', out.trim().split('\n').pop());

// 读回并检查
const buf = readFileSync(file);
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
ok(starts.length - 1 === 2, '输出仍是两帧容器（帧 0 只 header）', String(starts.length - 1));
const frame0 = zstdDecompressSync(buf.subarray(starts[0], starts[1])).toString('utf8');
ok(frame0.split('\n').filter(Boolean).length === 1, '第一帧只有一行');

const lines = zstdDecompressSync(buf.subarray(starts[1], starts[2])).toString('utf8').split('\n').filter(Boolean);
const list = lines.map((l) => JSON.parse(l));
const bySeq = new Map(list.map((e) => [e.seq, e]));
const dev = list.find((e) => e.type === 'developer/message');
ok(Boolean(dev), 'developer/message 还在');
ok(dev && dev.data.headerSeq !== undefined, 'headerSeq 仍在（没被丢掉）', String(dev?.data.headerSeq));
const target = dev ? bySeq.get(dev.data.headerSeq) : null;
ok(target?.type === 'request/header', 'headerSeq 仍指向 request/header', target?.type);
ok(dev && dev.data.headerSeq < dev.seq, 'headerSeq 在它自己之前');

rmSync(file, { force: true });

// 反向用例：引用指向「将被删除」的事件时，必须拒绝写入（不能悄悄改指或丢弃）
const file2 = join(CACHE, 'probe-repair-dangling.zstd');
rmSync(file2, { force: true });
const ev2 = [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  { seq: 4, type: 'step/start', time: 5, data: { turn: 1, step: 2 } },
  {
    seq: 5,
    type: 'developer/message',
    time: 6,
    // headerSeq 指向 seq3——正是要被删掉的那条
    data: { turn: 1, step: 2, message: { role: 'developer', content: [] }, headerSeq: 3 },
  },
  { seq: 6, type: 'step/end', time: 7, data: { turn: 1, step: 2 } },
  { seq: 7, type: 'turn/end', time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
];
const body2 = ev2.map((e) => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(
  file2,
  Buffer.concat([zstdCompressSync(Buffer.from(header + '\n', 'utf8')), zstdCompressSync(Buffer.from(body2, 'utf8'))]),
);
const before = readFileSync(file2);
let failedAsExpected = false;
try {
  execFileSync(process.execPath, [script, file2, '--write'], { encoding: 'utf8' });
} catch (err) {
  failedAsExpected = true;
}
ok(failedAsExpected, '引用指向被删事件时，脚本拒绝写入');
ok(Buffer.compare(before, readFileSync(file2)) === 0, '拒绝时原文件保持不变');
rmSync(file2, { force: true });

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
