#!/usr/bin/env node
// 修复会话日志里「落在 step 之外」的 system/message 事件。
//
// 背景：Tide 早期版本在 pre-step（step 还没开）和 turn/end 之后，用空 system 消息去
// 替换旧记忆块。宿主加载会话时要求 system/message 必须落在一个开着的 turn+step 里，
// 于是整个会话被判损坏、无法再打开。
//
// 这个脚本只做一件事：把这些非法事件删掉，并把 seq 重新排成连续的 0..N-1，
// 同时修正 surfaceOp / sourceEventSeqs / messageSeqs / through 里对 seq 的引用。
//
// 用法（务必在 DSH 关闭、该会话不在运行时执行）：
//   node scripts/repair-session-log.mjs "<session.v4.jsonl.zstd 的路径>" --dry-run
//   node scripts/repair-session-log.mjs "<路径>" --write
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const write = args.includes('--write');
const dry = !write;
if (!file || !existsSync(file)) {
  console.error('用法: node scripts/repair-session-log.mjs <session.v4.jsonl.zstd> [--dry-run|--write]');
  process.exit(2);
}

const raw = zstdDecompressSync(readFileSync(file)).toString('utf8');
const lines = raw.split('\n').filter((l) => l.trim());
const header = lines[0];
const events = lines.slice(1).map((l) => JSON.parse(l));

/** 按宿主规则找出非法事件下标：system/message 必须匹配一个开着的 turn+step。 */
function findIllegal(list) {
  const bad = new Set();
  let openTurn = null;
  let openStep = null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const d = e.data ?? {};
    if (e.type === 'turn/start') openTurn = d.turn ?? openTurn;
    if (e.type === 'step/start') {
      openStep = d.step ?? openStep;
    } else if (e.type === 'step/end') {
      openStep = null;
    } else if (e.type === 'turn/end') {
      openTurn = null;
      openStep = null;
    } else if (e.type === 'system/message') {
      if (openTurn === null || openStep === null || d.turn !== openTurn || d.step !== openStep) bad.add(i);
    }
  }
  return bad;
}

const bad = findIllegal(events);
console.log(`事件 ${events.length} 条，非法 system/message ${bad.size} 条`);
if (bad.size === 0) {
  console.log('无需修复。');
  process.exit(0);
}
for (const i of [...bad].slice(0, 20)) {
  const e = events[i];
  console.log('  删除 seq', e.seq, new Date(e.time).toLocaleString('zh-CN'), '| op', JSON.stringify(e.surfaceOp ?? 'append'));
}
if (dry) {
  console.log('（预览模式，未写入。加 --write 才会修改文件）');
  process.exit(0);
}

// 建映射：旧 seq -> 新 seq（被删的没有）
const kept = events.filter((_, i) => !bad.has(i));
const map = new Map();
let n = 0;
for (let i = 0; i < events.length; i++) {
  if (bad.has(i)) continue;
  map.set(events[i].seq, n);
  n += 1;
}
const remap = (v) => (map.has(v) ? map.get(v) : undefined);

const out = kept.map((e) => {
  const c = JSON.parse(JSON.stringify(e));
  c.seq = map.get(e.seq);
  if (c.surfaceOp && c.surfaceOp.op === 'replace') {
    c.surfaceOp.startSeq = remap(c.surfaceOp.startSeq);
    c.surfaceOp.endSeq = remap(c.surfaceOp.endSeq);
  }
  if (Array.isArray(c.sourceEventSeqs)) {
    c.sourceEventSeqs = c.sourceEventSeqs.map(remap).filter((v) => v !== undefined);
  }
  if (c.data) {
    if (Array.isArray(c.data.messageSeqs)) c.data.messageSeqs = c.data.messageSeqs.map(remap).filter((v) => v !== undefined);
    if (c.data.through !== undefined) c.data.through = remap(c.data.through) ?? c.data.through;
  }
  return JSON.stringify(c);
});

// 再校验一遍
const check = out.map((l) => JSON.parse(l));
const left = findIllegal(check);
if (left.size !== 0) {
  console.error('修复后仍有非法事件，放弃写入。', left.size);
  process.exit(1);
}

const body = [header, ...out].join('\n') + '\n';
const tmp = `${file}.repaired-${Date.now()}`;
writeFileSync(tmp, zstdCompressSync(Buffer.from(body, 'utf8')));
renameSync(tmp, file);
console.log(`已写回：${events.length} → ${check.length} 条事件，seq 连续 0..${check.length - 1}`);
