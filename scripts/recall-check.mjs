// 线上召回自检（只读）：模拟一次注入，看看"问某句话"会拿到什么。
// 用法：node scripts/recall-check.mjs "我今天吃了什么" [群openid|私聊openid]
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { searchEvents } from '../lib/fts.js';
import { selectFactsForUsers, renderFactBlock, renderEventBlock } from '../lib/context.js';

const dbFile = process.env.MEMORY_DB ?? `${process.env.USERPROFILE}/.dsh/chat-memory/memory.db`;
const query = process.argv[2] ?? '我今天吃了什么';
const peer = process.argv[3] ?? process.env.CM_PEER ?? 'AAAA0000BBBB1111CCCC2222DDDD3333';
const isC2c = peer.startsWith('AAAA0000');

const db = new DatabaseSync(dbFile, { allowExtension: true });
try {
  db.loadExtension(getLoadablePath());
} catch {
  /* 向量不可用时只用 FTS */
}

const conversationKey = `qq:${peer}`;
const latest = db
  .prepare('SELECT user_id AS uid FROM raw_log WHERE conversation_key = ? AND user_id IS NOT NULL ORDER BY observed_at DESC LIMIT 1')
  .get(conversationKey);

console.log('查询:', query);
console.log('会话:', conversationKey, isC2c ? '(私聊)' : '(群)');

const facts = selectFactsForUsers(db, { userIds: [peer, latest?.uid], limit: 30 });
console.log(`\n[事实] ${facts.length} 条`);
for (const f of facts.slice(0, 8)) console.log('  -', f.canonicalKey, '=', String(f.value).slice(0, 40));

const recent = db
  .prepare(
    `SELECT event_id AS eventId, event_type AS eventType, content, occurred_at AS occurredAt, conversation_key AS conversationKey
       FROM event
      WHERE conversation_key = ? AND status = 'active' AND event_type IN ('observation','conversation')
        AND occurred_at > ?
      ORDER BY occurred_at DESC LIMIT 5`,
  )
  .all(conversationKey, Date.now() - 7 * 86_400_000);

const found = searchEvents(db, query, 5);
const seen = new Set(recent.map((e) => e.eventId));
const events = [
  ...recent,
  ...found.filter((e) => !seen.has(e.eventId) && (isC2c || e.conversationKey === conversationKey)),
].slice(0, 8);

console.log(`\n[经历] 本会话近 7 天 ${recent.length} 条 / 检索命中 ${found.length} 条 → 取 ${events.length} 条`);
for (const e of events) console.log('  -', (e.content ?? '').slice(0, 50));

const block = [renderFactBlock(facts), renderEventBlock(events)].filter(Boolean).join('\n\n');
console.log('\n===== 实际注入块 =====');
console.log(block || '(空，不会注入)');
db.close();
