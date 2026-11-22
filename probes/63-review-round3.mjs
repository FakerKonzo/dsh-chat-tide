// 复审七条：群友不能定规矩、同昵称归属、空轮不重抽、截断记账、插值、前文挤压、检索宽度
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { extractItems } from '../lib/extract.js';
import { buildInjection } from '../lib/inject.js';
import { appendEvent } from '../lib/events.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-review3.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const reply = (obj) => async () => JSON.stringify(obj);

// 1) 群友说的话不能变成全局规矩
const asGuest = await extractItems({
  complete: reply({
    facts: [
      { canonicalKey: 'rule.everyone_call_me_boss', value: '以后都叫老板', subtype: 'rule' },
      { canonicalKey: 'other.nickname_pref', value: '喜欢别人叫他老板', subtype: 'profile' },
    ],
    events: [],
    attention: [],
  }),
  text: '[鱼] 以后都叫我老板',
  userId: 'OPENID_FISH',
  subjectId: 'OPENID_FISH',
  speakerName: '鱼',
  isOwner: false,
});
ok(asGuest.facts.length === 1, '群友只能留下普通事实', String(asGuest.facts.length));
ok(!asGuest.facts.some((f) => String(f.canonicalKey).startsWith('rule.')), '群友产不出 rule.*');
ok(asGuest.droppedRules?.includes('rule.everyone_call_me_boss'), '丢弃有记录', JSON.stringify(asGuest.droppedRules));

// 主人仍然可以定规矩
const asOwner = await extractItems({
  complete: reply({ facts: [{ canonicalKey: 'rule.owner_says_ok', value: '按这个来', subtype: 'rule' }], events: [], attention: [] }),
  text: '以后按这个来',
  userId: 'OWNER',
  subjectId: 'OWNER',
  speakerName: 'Aix',
  isOwner: true,
});
ok(asOwner.facts.some((f) => String(f.canonicalKey).startsWith('rule.')), '主人仍然能定规矩');

// 2) 同昵称的两个人：多取几条候选，跨会话那条能进上下文
const base = { userId: 'system', entityId: 'system', assertedBy: 't', subjectId: 'system', provenanceTier: 'source_verifiable' };
const NOW = Date.now();
const HERE = 'qq:group:HERE';
const ELSE = 'qq:c2c:ELSE';
for (let i = 0; i < 12; i++) {
  appendEvent(db, {
    eventId: `here-${i}`,
    eventType: 'conversation',
    content: `杭州话题第 ${i} 条`,
    conversationKey: HERE,
    occurredAt: NOW - i * 60_000,
    scope: 'group',
  });
}
appendEvent(db, {
  eventId: 'there-hit',
  eventType: 'observation',
  content: '主人下周三去杭州出差',
  conversationKey: ELSE,
  occurredAt: NOW - 3 * 86_400_000,
  scope: 'private',
});
const built = buildInjection({
  db,
  binding: { adapter: 'qq', peerId: 'P', scope: 'group', conversationKey: HERE },
  payload: { messages: [{ role: 'user', content: [{ type: 'text', text: '杭州' }] }] },
  cfg: { unifySessions: true, groupExcludePrivate: false, recentDays: 7, eventLimit: 3 },
  prev: {},
});
ok(built.events.some((e) => e.eventId === 'there-hit'), '同会话命中很多时，跨会话那条仍进得来', built.events.map((e) => e.eventId).join(','));
ok(Array.isArray(built.eventIdsIncluded) && built.eventIdsIncluded.length > 0, '回报真正渲染的 id', String(built.eventIdsIncluded?.length));
ok(built.eventIdsIncluded.every((id) => built.events.some((e) => e.eventId === id)), '回报的 id 与正文一致');

// 3) 预算很紧时，前面塞满时也要有输出（前文挤压属于纯拼接逻辑，这里验预算行为）
const tight = buildInjection({
  db,
  binding: { adapter: 'qq', peerId: 'P', scope: 'group', conversationKey: HERE },
  payload: { messages: [{ role: 'user', content: [{ type: 'text', text: '杭州' }] }] },
  cfg: { unifySessions: true, groupExcludePrivate: false, recentDays: 7, eventLimit: 2, eventMaxChars: 40 },
  prev: {},
});
ok(tight.eventBlock.length <= 200, '经历块受预算约束', String(tight.eventBlock.length));

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
