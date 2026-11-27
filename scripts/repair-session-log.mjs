#!/usr/bin/env node
// 修复会话日志里「落在 step 之外」的 system/message 事件。
//
// 背景：Tide 0.6.3 及更早版本在 pre-step（step 还没开）和 turn/end 之后，用空 system
// 消息去替换旧记忆块。宿主加载会话时要求 system/message 必须落在一个开着的 turn+step 里，
// 于是整个会话被判损坏、无法再打开。
//
// 0.6.4 起不再这样写；这个脚本用来修旧版本留下的坏日志。
//
// 宿主的日志是「多帧 zstd 容器」：第一帧只装 header 一行（JSON + \n），
// 其余每帧装一批事件行。修复后必须保持这个布局，不能压成单帧。
//
// 用法（务必在 DSH 关闭、这些会话都不在运行时执行）：
//   node scripts/repair-session-log.mjs --scan <sessions 根目录>           只体检，列出坏会话
//   node scripts/repair-session-log.mjs --scan <sessions 根目录> --write   体检并修复
//   node scripts/repair-session-log.mjs "<单个 session.v4.jsonl.zstd>" --write
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const args = process.argv.slice(2);
const write = args.includes('--write');
const scanIdx = args.indexOf('--scan');
const scanRoot = scanIdx >= 0 ? args[scanIdx + 1] : null;
const skip = scanIdx >= 0 ? new Set([scanIdx + 1]) : new Set();
const file = args.find((a, i) => !a.startsWith('--') && !skip.has(i));

if (!scanRoot && (!file || !existsSync(file))) {
  console.error('用法: node scripts/repair-session-log.mjs <session.v4.jsonl.zstd>|--scan <root> [--write]');
  process.exit(2);
}

/** 多帧容器 → [headerLine, ...eventLines] */
function readLog(path) {
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
  if (starts.length === 0 || starts[0] !== 0) throw new Error('不是 zstd 多帧容器（或帧没有从文件头开始）');
  starts.push(buf.length);
  const lines = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const plain = zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])).toString('utf8');
    for (const l of plain.split('\n')) if (l.trim()) lines.push(l);
  }
  return { header: lines[0], events: lines.slice(1).map((l) => JSON.parse(l)) };
}

/** 按宿主规则找出非法事件下标：system/message 必须匹配一个开着的 turn+step。 */
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

/** 修好的内容 → 宿主格式的多帧缓冲：帧 0 只装 header 一行，帧 1 装全部事件行。 */
function encodeContainer(headerLine, eventLines) {
  const headerFrame = zstdCompressSync(Buffer.from(headerLine.endsWith('\n') ? headerLine : headerLine + '\n', 'utf8'));
  const body = eventLines.length ? eventLines.join('\n') + '\n' : '';
  const eventFrame = body ? zstdCompressSync(Buffer.from(body, 'utf8')) : Buffer.alloc(0);
  return Buffer.concat([headerFrame, eventFrame]);
}

/** 修复后的结构校验：非法 system/message、悬空/指错类型的引用、seq 连续性。 */
function verifyRepaired(list) {
  const problems = [];
  if (findIllegal(list).size) problems.push('仍有非法 system/message');
  const bySeq = new Map(list.map((e) => [e.seq, e]));
  for (let i = 0; i < list.length; i++) {
    if (list[i].seq !== i) {
      problems.push(`seq 不连续：第 ${i} 条是 ${list[i].seq}`);
      break;
    }
  }
  const need = (v, wantType, where) => {
    const t = bySeq.get(v);
    if (!t) problems.push(`${where} 指向不存在的 ${v}`);
    else if (wantType && t.type !== wantType) problems.push(`${where} 指向 ${t.type}，应为 ${wantType}`);
  };
  for (const e of list) {
    if (e.type === 'developer/message' && e.data?.headerSeq !== undefined) {
      if (e.data.headerSeq >= e.seq) problems.push(`seq ${e.seq} headerSeq 不在它之前`);
      need(e.data.headerSeq, 'request/header', `seq ${e.seq} headerSeq`);
    }
    if (Array.isArray(e.data?.messageSeqs)) for (const q of e.data.messageSeqs) need(q, 'user/message', `seq ${e.seq} messageSeqs`);
    if (Array.isArray(e.data?.targets)) {
      for (const t of e.data.targets) {
        if (t?.seq === undefined) continue;
        const target = bySeq.get(t.seq);
        if (!target) problems.push(`seq ${e.seq} targets 指向不存在的 ${t.seq}`);
        // 图片重定位必须仍落在一条带图片的 user 消息上
        else {
          const blocks = target.type === 'user/message' ? target.data?.content ?? [] : [];
          const hasImage = blocks.some((b) => b?.type === 'image');
          if (!hasImage) problems.push(`seq ${e.seq} targets 指向 ${target.type} 且没有图片`);
        }
      }
    }
    for (const q of e.sourceEventSeqs ?? []) need(q, null, `seq ${e.seq} sourceEventSeqs`);
  }
  return problems;
}

function repair(path, { dry }) {
  const { header, events } = readLog(path);
  const bad = findIllegal(events);
  const tag = path.split(/[\\/]/).slice(-2, -1)[0] ?? path;
  if (bad.size === 0) return { path, tag, bad: 0, changed: false };
  console.log(`\n${tag}: ${events.length} 条事件，非法 system/message ${bad.size} 条`);
  if (dry) {
    for (const i of [...bad].slice(0, 5)) {
      const e = events[i];
      console.log('  将删除 seq', e.seq, new Date(e.time).toLocaleString('zh-CN'));
    }
    if (bad.size > 5) console.log(`  …另有 ${bad.size - 5} 条`);
    return { path, tag, bad: bad.size, changed: false };
  }
  const kept = events.filter((_, i) => !bad.has(i));
  const map = new Map();
  let n = 0;
  for (let i = 0; i < events.length; i++) {
    if (bad.has(i)) continue;
    map.set(events[i].seq, n);
    n += 1;
  }
  // 所有指向 SessionSeq 的字段都必须重映射。漏一个（例如 developer/message.headerSeq）
  // 就会把引用指到别的条上，宿主照样打不开会话。任何引用落到被删的事件上，一律放弃写入。
  const dangling = [];
  const remapOne = (v, where) => {
    if (v === undefined || v === null) return v;
    // 区间引用：[[start, end]] 表示 start..end 连续一段，每个端点都要重排
    if (Array.isArray(v)) {
      if (v.length !== 2 || !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || v[1] < v[0]) {
        dangling.push(`${where} 不是合法区间：${JSON.stringify(v)}`);
        return v;
      }
      return [remapOne(v[0], `${where}[0]`), remapOne(v[1], `${where}[1]`)];
    }
    if (!map.has(v)) {
      dangling.push(`${where}=${v}`);
      return v;
    }
    return map.get(v);
  };
  const remapList = (arr, where) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((v, i) => remapOne(v, `${where}[${i}]`));
  };

  const out = kept.map((e) => {
    const c = JSON.parse(JSON.stringify(e));
    c.seq = map.get(e.seq);
    if (c.surfaceOp && c.surfaceOp.op === 'replace') {
      c.surfaceOp.startSeq = remapOne(c.surfaceOp.startSeq, `${e.seq}.surfaceOp.startSeq`);
      c.surfaceOp.endSeq = remapOne(c.surfaceOp.endSeq, `${e.seq}.surfaceOp.endSeq`);
    }
    if (Array.isArray(c.sourceEventSeqs)) c.sourceEventSeqs = remapList(c.sourceEventSeqs, `${e.seq}.sourceEventSeqs`);
    const d = c.data;
    if (d && typeof d === 'object') {
      if (d.headerSeq !== undefined) d.headerSeq = remapOne(d.headerSeq, `${e.seq}.headerSeq`);
      if (d.sourceEventSeq !== undefined) d.sourceEventSeq = remapOne(d.sourceEventSeq, `${e.seq}.sourceEventSeq`);
      if (d.throughSeq !== undefined) d.throughSeq = remapOne(d.throughSeq, `${e.seq}.throughSeq`);
      if (Array.isArray(d.messageSeqs)) d.messageSeqs = remapList(d.messageSeqs, `${e.seq}.messageSeqs`);
      if (Array.isArray(d.shadowedSeqs)) d.shadowedSeqs = remapList(d.shadowedSeqs, `${e.seq}.shadowedSeqs`);
      if (Array.isArray(d.targets)) {
        d.targets = d.targets.map((t, i) => {
          if (t && typeof t === 'object' && t.seq !== undefined) {
            t.seq = remapOne(t.seq, `${e.seq}.targets[${i}].seq`);
          }
          return t;
        });
      }
      if (d.shadowedRange && typeof d.shadowedRange === 'object') {
        d.shadowedRange.start = remapOne(d.shadowedRange.start, `${e.seq}.shadowedRange.start`);
        d.shadowedRange.end = remapOne(d.shadowedRange.end, `${e.seq}.shadowedRange.end`);
      }
    }
    return JSON.stringify(c);
  });

  if (dangling.length) {
    console.error(`  ${tag}: 有引用指向已被删除的事件，放弃写入：${dangling.slice(0, 5).join(', ')}`);
    return { path, tag, bad: bad.size, changed: false, failed: true };
  }

  const repaired = out.map((l) => JSON.parse(l));
  const problems = verifyRepaired(repaired);
  if (problems.length) {
    console.error(`  ${tag}: 修复后校验不过，已放弃写入：${problems.slice(0, 3).join('; ')}`);
    return { path, tag, bad: bad.size, changed: false, failed: true };
  }
  // 宿主格式：多帧。第一帧只装 header 一行，其余装事件行。
  const body = [header, ...out].join('\n') + '\n';
  const tmp = `${path}.repaired-${Date.now()}`;
  writeFileSync(tmp, encodeContainer(header, out));
  renameSync(tmp, path);
  console.log(`  已修复：${events.length} → ${out.length} 条事件，seq 连续 0..${out.length - 1}`);
  return { path, tag, bad: bad.size, changed: true };
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
  let fixed = 0;
  const failed = [];
  for (const f of files) {
    let r;
    try {
      r = repair(f, { dry: !write });
    } catch (err) {
      console.log(`\n${f.slice(-60)}: 读取失败 ${String(err?.message ?? err)}`);
      failed.push(f);
      continue;
    }
    if (!r.bad) continue;
    broken += 1;
    if (r.failed) failed.push(f);
    else if (r.changed) fixed += 1;
  }
  if (!write) {
    console.log(`\n共 ${broken} 个会话需要修复；加 --write 执行修复`);
  } else {
    console.log(`\n共 ${broken} 个会话需要修复：成功 ${fixed}，失败 ${failed.length}`);
    for (const f of failed) console.log('  失败：' + f);
  }
  process.exit(failed.length ? 1 : 0);
}

const r = repair(file, { dry: !write });
if (r.bad === 0) console.log('无需修复。');
process.exit(r.failed ? 1 : 0);
