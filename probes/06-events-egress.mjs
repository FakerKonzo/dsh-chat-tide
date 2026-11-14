// 事件层 + 出站闸门自测（不依赖宿主）。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { appendEvent, appendRawLog } from '../lib/events.js';
import { searchEvents } from '../lib/fts.js';
import { createEgress } from '../lib/egress.js';

const FILE = fileURLToPath(new URL('../.cache/probe-events.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 入站判重：同内容同窗口只进一条
// 固定到窗口内的安全位置：跨桶会让“同窗口判重”随机失败（CI 上就这么翻过车）
const WINDOW = 10_000;
const t0 = Math.floor(Date.now() / WINDOW) * WINDOW + 1_000;
const a = appendRawLog(db, { recordId: 'r1', recordType: 'message', adapter: 'qq', peerId: 'g1', conversationKey: 'qq:g1', payload: '在吗', observedAt: t0 });
const b = appendRawLog(db, { recordId: 'r2', recordType: 'message', adapter: 'qq', peerId: 'g1', conversationKey: 'qq:g1', payload: '在吗', observedAt: t0 + 1000 });
ok(a.inserted === true && b.inserted === false, '同窗口重复投递被判重', JSON.stringify([a.inserted, b.inserted]));

// 2) 有 msgId 时强幂等
const c = appendRawLog(db, { recordId: 'r3', recordType: 'message', adapter: 'qq', peerId: 'g1', conversationKey: 'qq:g1', payload: '在吗', observedAt: t0 + 60000, platformMsgId: 'ROBOT1.0_x' });
const d = appendRawLog(db, { recordId: 'r4', recordType: 'message', adapter: 'qq', peerId: 'g1', conversationKey: 'qq:g1', payload: '完全不同的话', observedAt: t0 + 120000, platformMsgId: 'ROBOT1.0_x' });
ok(c.inserted === true && d.inserted === false, '平台 msgId 跨窗口仍判重', JSON.stringify([c.inserted, d.inserted]));

// 3) 事件索引：conversation 可召回，route_decision 不可
appendEvent(db, { eventId: 'e1', eventType: 'conversation', content: '主人下周三去杭州出差', conversationKey: 'qq:g1', occurredAt: t0 });
appendEvent(db, { eventId: 'e2', eventType: 'route_decision', content: '主人下周三去杭州出差', conversationKey: 'qq:g1', occurredAt: t0 });
const hits = searchEvents(db, '杭州');
ok(hits.length === 1 && hits[0].eventId === 'e1', '审计事件不进召回索引', JSON.stringify(hits.map((h) => h.eventId)));

// 4) 出站闸门：声明 stay_silent 的那一轮，正文被丢
const chunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '（这句本来要发出去）' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '（这句本来要发出去）' } },
  { type: 'tool-call-delta', index: 1, id: 'c1', name: 'stay_silent', argumentsDelta: '{}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'stay_silent', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
];
const egress = createEgress({ isBindable: () => true, cfg: { holdTextOnSilence: true } });
async function collect(iter) {
  const out = [];
  for await (const c of iter) out.push(c);
  return out;
}
const silentOut = await collect(egress.wrapStream('s1', (async function* () { for (const c of chunks) yield c; })()));
const silentText = silentOut.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
ok(silentText === '', '静默轮的 text-delta 被丢弃', JSON.stringify(silentText));
const silentEnd = silentOut.find((c) => c.type === 'block-end' && c.block?.type === 'text');
ok(silentEnd?.block?.text === '', '静默轮的文本块被清空');

// 5) 普通轮：正文原样通过
const normal = chunks.filter((c) => !(c.type === 'tool-call-delta') && c.block?.name !== 'stay_silent');
const normalOut = await collect(egress.wrapStream('s2', (async function* () { for (const c of normal) yield c; })()));
const normalText = normalOut.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
ok(normalText.includes('这句本来要发出去'), '普通轮正文保留', JSON.stringify(normalText));

// 6) 非受管会话：直通
const unbound = createEgress({ isBindable: (id) => id === 's1' || id === 's2', cfg: { holdTextOnSilence: true } });
const rawOut = await collect(unbound.wrapStream('s3', (async function* () { for (const c of chunks) yield c; })()));
ok(rawOut.length === chunks.length, '作用域外直通不改写');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
