// 修复工具：区间引用、image/offload 重定位、批量汇总必须如实报失败
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const header = JSON.stringify({ type: 'session', version: 4, id: 'probe-76', createdAt: 1, cwd: '/x' });
const script = fileURLToPath(new URL('../scripts/repair-session-log.mjs', import.meta.url));

function writeLog(path, events) {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(
    path,
    Buffer.concat([zstdCompressSync(Buffer.from(header + '\n', 'utf8')), zstdCompressSync(Buffer.from(body, 'utf8'))]),
  );
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
  for (let k = 0; k < starts.length - 1; k++) {
    for (const l of zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])).toString('utf8').split('\n')) {
      if (l.trim()) lines.push(l);
    }
  }
  return { header: lines[0], events: lines.slice(1).map((l) => JSON.parse(l)), frames: starts.length - 1 };
}

// ── 用例 A：区间引用 + image/offload 都必须重排 ──
const a = join(CACHE, 'probe76-a.zstd');
rmSync(a, { force: true });
const imgUser = {
  seq: 4,
  type: 'user/message',
  time: 5,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
};
const evA = [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  // 非法：step 已关
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  imgUser,
  { seq: 5, type: 'image/offload', time: 6, data: { targets: [{ seq: 4, blockIndex: 0 }] } },
  {
    seq: 6,
    type: 'compaction/summary',
    time: 7,
    data: {
      compactionId: 'c1',
      summary: [{ type: 'text', text: 's' }],
      shadowedRange: [0, 2],
      shadowedSeqs: [0, 1, 2],
      shadowedTokenCount: 3,
      provider: 'p',
      model: 'm',
    },
  },
  { seq: 7, type: 'turn/end', time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
];
writeLog(a, evA);
let outA = '';
try {
  outA = execFileSync(process.execPath, [script, a, '--write'], { encoding: 'utf8' });
} catch (err) {
  outA = String(err.stdout || err.message);
}
ok(/已修复/.test(outA), 'A：脚本完成修复', outA.trim().split('\n').pop());

const ra = readEvents(a);
const offload = ra.events.find((e) => e.type === 'image/offload');
const targetSeq = offload?.data?.targets?.[0]?.seq;
const targetEv = ra.events.find((e) => e.seq === targetSeq);
ok(targetSeq === 3, 'A：image/offload 的 targets.seq 重排为 3（原 4，删掉一条后前移）', String(targetSeq));
ok(
  targetEv?.type === 'user/message' && (targetEv.data.content ?? []).some((b) => b.type === 'image'),
  'A：指向的仍是一条带图片的 user 消息',
  targetEv?.type,
);
const sum = ra.events.find((e) => e.type === 'compaction/summary');
ok(Array.isArray(sum?.data?.shadowedRange) && sum.data.shadowedRange[1] === 2, 'A：区间引用端点已重排', JSON.stringify(sum?.data?.shadowedRange));
ok(ra.frames === 2, 'A：输出仍是两帧容器', String(ra.frames));
rmSync(a, { force: true });

// ── 用例 B：区间端点指向被删事件时必须拒绝 ──
const b = join(CACHE, 'probe76-b.zstd');
rmSync(b, { force: true });
const evB = [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'step/start', time: 2, data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
  { seq: 3, type: 'system/message', time: 4, data: { turn: 1, step: 1, message: { role: 'system', content: [] } } },
  {
    seq: 4,
    type: 'compaction/prune',
    time: 5,
    // 区间端点 3 正是要被删的那条
    data: { shadowedRange: [3, 4], shadowedSeqs: [3, 4], shadowedTokenCount: 2 },
  },
  { seq: 5, type: 'turn/end', time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
];
writeLog(b, evB);
const beforeB = readFileSync(b);
let refused = false;
try {
  execFileSync(process.execPath, [script, b, '--write'], { encoding: 'utf8' });
} catch {
  refused = true;
}
ok(refused, 'B：区间端点指向被删事件时拒绝写入');
ok(Buffer.compare(beforeB, readFileSync(b)) === 0, 'B：拒绝时原文件不变');
rmSync(b, { force: true });

// ── 用例 C：批量扫描必须把失败会话报成失败，不能说"已处理" ──
const dir = join(CACHE, 'probe76-scan');
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, 'good'), { recursive: true });
mkdirSync(join(dir, 'bad'), { recursive: true });
writeLog(join(dir, 'good', 'session.v4.jsonl.zstd'), evA);
writeLog(join(dir, 'bad', 'session.v4.jsonl.zstd'), evB);
let outC = '';
try {
  outC = execFileSync(process.execPath, [script, '--scan', dir, '--write'], { encoding: 'utf8' });
} catch (err) {
  outC = String(err.stdout || err.message) + String(err.stderr || '');
}
ok(/失败 1/.test(outC) || /1 个失败/.test(outC), 'C：批量汇总明确报出失败数', outC.trim().split('\n').slice(-2).join(' | '));
ok(!/已处理 2/.test(outC), 'C：不把失败会话计入已处理');
rmSync(dir, { recursive: true, force: true });

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
