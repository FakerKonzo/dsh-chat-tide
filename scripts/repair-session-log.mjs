#!/usr/bin/env node
// 修复会话日志里「落在 step 之外」的 system/message 事件。
//
// 背景：Tide 0.6.3 及更早版本在 pre-step（step 还没开）和 turn/end 之后，用空 system
// 消息去替换旧记忆块。宿主加载会话时要求 system/message 必须落在一个开着的 turn+step 里，
// 于是整个会话被判损坏、无法再打开。
//
// 0.6.4 起不再这样写；这个脚本用来修旧版本留下的坏日志。
//
// 用法（务必在 DSH 关闭、这些会话都不在运行时执行）：
//   node scripts/repair-session-log.mjs --scan <sessions 根目录>           只体检，列出坏会话
//   node scripts/repair-session-log.mjs --scan <sessions 根目录> --write   体检并修复
//   node scripts/repair-session-log.mjs "<单个 session.v4.jsonl.zstd>" --write
//
// 只做两件事：删掉非法事件，把 seq 重排成连续的 0..N-1，并修正所有对 seq 的引用。
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const args = process.argv.slice(2);
const write = args.includes('--write');
const scanIdx = args.indexOf('--scan');
const scanRoot = scanIdx >= 0 ? args[scanIdx + 1] : null;
const file = args.find((a, i) => !a.startsWith('--') && i !== scanIdx + 1);

if (!scanRoot && (!file || !existsSync(file))) {
  console.error('用法: node scripts/repair-session-log.mjs <session.v4.jsonl.zstd>|--scan <root> [--write]');
  process.exit(2);
}

/** 复刻宿主规则：system/message 必须匹配一个开着的 turn+step。 */
function findIllegal(list) {
  const bad = new Set();
  let openTurn = null;
  let openStep = null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const d = e.data ?? {};
    if (e.type === 'turn/start') openTurn = d.turn ?? openTurn;
    else if (e.type === 'step/start') openStep = d.step ?? openStep;
    else if (e.type === 'step/end') openStep = null;
    else if (e.type === 'turn/end') {
      openTurn = null;
      openStep = null;
    } else if (e.type === 'system/message') {
      if (openTurn === null || openStep === null || d.turn !== openTurn || d.step !== openStep) bad.add(i);
    }
  }
  return bad;
}

function readLog(path) {
  const raw = zstdDecompressSync(readFileSync(path)).toString('utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  return { header: lines[0], events: lines.slice(1).map((l) => JSON.parse(l)) };
}

function repair(path, { dry }) {
  const { header, events } = readLog(path);
  const bad = findIllegal(events);
  const tag = path.split(/[\\/]/).slice(-2, -1)[0] ?? path;
  if (bad.size === 0) return { path, bad: 0, changed: false };
  console.log(`\n${tag}: ${events.length} 条事件，非法 system/message ${bad.size} 条`);
  if (dry) {
    for (const i of [...bad].slice(0, 5)) {
      const e = events[i];
      console.log('  将删除 seq', e.seq, new Date(e.time).toLocaleString('zh-CN'));
    }
    if (bad.size > 5) console.log(`  …另有 ${bad.size - 5} 条`);
    return { path, bad: bad.size, changed: false };
  }
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
    if (Array.isArray(c.sourceEventSeqs)) c.sourceEventSeqs = c.sourceEventSeqs.map(remap).filter((v) => v !== undefined);
    if (c.data) {
      if (Array.isArray(c.data.messageSeqs)) c.data.messageSeqs = c.data.messageSeqs.map(remap).filter((v) => v !== undefined);
      if (c.data.through !== undefined) c.data.through = remap(c.data.through) ?? c.data.through;
    }
    return JSON.stringify(c);
  });
  if (findIllegal(out.map((l) => JSON.parse(l))).size !== 0) {
    console.error(`  ${tag}: 修复后仍有非法事件，已放弃写入`);
    return { path, bad: bad.size, changed: false, failed: true };
  }
  const body = [header, ...out].join('\n') + '\n';
  const tmp = `${path}.repaired-${Date.now()}`;
  writeFileSync(tmp, zstdCompressSync(Buffer.from(body, 'utf8')));
  renameSync(tmp, path);
  console.log(`  已修复：${events.length} → ${out.length} 条事件，seq 连续 0..${out.length - 1}`);
  return { path, bad: bad.size, changed: true };
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name === 'session.v4.jsonl.zstd') out.push(p);
  }
}

if (scanRoot) {
  if (!existsSync(scanRoot)) {
    console.error('目录不存在:', scanRoot);
    process.exit(2);
  }
  const files = [];
  walk(scanRoot, files);
  console.log(`扫描 ${files.length} 个会话日志${write ? '（修复模式）' : '（只体检，加 --write 才修）'}`);
  let broken = 0;
  for (const f of files) {
    const r = repair(f, { dry: !write });
    if (r.bad) broken += 1;
  }
  console.log(`\n共 ${broken} 个会话需要修复${write ? '，已处理' : '；加 --write 执行修复'}`);
  process.exit(0);
}

const r = repair(file, { dry: !write });
if (r.bad === 0) console.log('无需修复。');
process.exit(r.failed ? 1 : 0);
