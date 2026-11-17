// 经历注入：检索命中的相关经历不能被当前会话的近期记录挤光
// 复现：当前会话近期已有 5 条，另一会话里检索命中 1 条 —— 修复前命中进不来。
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { appendEvent } from '../lib/events.js';
import { buildInjection } from '../lib/inject.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-event-reserve.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const NOW = Date.now();
const HERE = 'qq:group:HERE';
const ELSEWHERE = 'qq:c2c:ELSE';

// 当前会话：5 条无关的近期经历，把名额占满
for (let i = 0; i < 5; i++) {
  appendEvent(db, {
    eventId: `here-${i}`,
    eventType: 'observation',
    content: `今天天气还行第 ${i} 次`,
    conversationKey: HERE,
    occurredAt: NOW - i * 60_000,
    scope: 'group',
  });
}
// 另一个会话：一条与提问强相关的经历
appendEvent(db, {
  eventId: 'there-1',
  eventType: 'observation',
  content: '主人下周三去杭州出差',
  conversationKey: ELSEWHERE,
  occurredAt: NOW - 3 * 86_400_000,
  scope: 'private',
});

const binding = { adapter: 'qq', peerId: 'PEER', scope: 'group', conversationKey: HERE };
const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: '我下周去杭州要注意什么' }] }] };
const base = { unifySessions: true, groupExcludePrivate: false, recentDays: 7, eventLimit: 5 };

const withReserve = buildInjection({ db, binding, payload, cfg: base, prev: {} });
ok(withReserve.eventBlock.includes('杭州'), '名额占满时，相关经历仍能进上下文', withReserve.events.map((e) => e.eventId).join(','));
ok(withReserve.events.some((e) => e.eventId === 'there-1'), '命中的正是另一会话那条');
ok(withReserve.events.length === 5, '总条数仍受 eventLimit 约束', String(withReserve.events.length));

const noReserve = buildInjection({ db, binding, payload, cfg: { ...base, eventRelatedReserve: 0 }, prev: {} });
ok(!noReserve.events.some((e) => e.eventId === 'there-1'), '关掉预留就退回旧行为（用于对照）');

// 近期不足时，命中要能把空位填满
const few = openDatabase(FILE);
few.prepare("UPDATE event SET status='deleted' WHERE conversation_key=? AND event_id IN ('here-0','here-1','here-2','here-3')").run(HERE);
const filled = buildInjection({ db: few, binding, payload, cfg: base, prev: {} });
ok(filled.events.some((e) => e.eventId === 'there-1'), '近期不足时命中照样进来');

// 没开共享时，别的会话经历不该出现
const isolated = buildInjection({ db, binding, payload, cfg: { ...base, unifySessions: false }, prev: {} });
ok(!isolated.events.some((e) => e.eventId === 'there-1'), '没开共享就不跨会话');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
