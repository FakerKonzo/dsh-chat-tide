// 补偿抽取自测（假模型，不联网）
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { appendRawLog } from '../lib/events.js';
import { findMissedExtractions, runRepairExtractions } from '../lib/repair.js';

const FILE = fileURLToPath(new URL('../.cache/probe-repair.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const now = Date.now();
appendRawLog(db, { recordId: 'r1', recordType: 'message', adapter: 'local', peerId: 'p1', conversationKey: 'local:p1', payload: '今天我吃了三个饼', observedAt: now, correlationId: 's1:1' });
appendRawLog(db, { recordId: 'r2', recordType: 'message', adapter: 'local', peerId: 'p1', conversationKey: 'local:p1', payload: '我住在杭州', observedAt: now, correlationId: 's1:2' });

const missed = findMissedExtractions(db, { now, limit: 10 });
ok(missed.length === 2, '找出漏抽的轮次', `n=${missed.length}`);

const complete = async (msgs) => {
  const text = msgs.find((m) => m.role === 'user').content;
  if (text.includes('饼')) return JSON.stringify({ facts: [], events: [{ content: '今天吃了三个饼' }] });
  return JSON.stringify({ facts: [{ canonicalKey: 'city', value: '杭州' }], events: [] });
};

const rep = await runRepairExtractions(db, { complete, limit: 10, now, log: () => {} });
ok(rep.attempted === 2, '补跑两条', JSON.stringify(rep));
ok(rep.events === 1, '写入 1 条 observation');
ok(rep.facts === 1, '写入 1 条 fact');
ok(db.prepare("SELECT count(*) c FROM event WHERE event_type='observation'").get().c === 1, '事件表有 observation');
ok(db.prepare("SELECT count(*) c FROM fact WHERE status='active'").get().c === 1, '事实表有 active 记录');
ok(db.prepare("SELECT count(*) c FROM fact_version WHERE embedding_pending=1").get().c === 1, '新事实标记待补向量');

const again = findMissedExtractions(db, { now, limit: 10 });
ok(again.length === 0, '补完不再重复出现');

const rep2 = await runRepairExtractions(db, { complete, limit: 10, now, log: () => {} });
ok(rep2.attempted === 0, '再次补跑无事可做');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
