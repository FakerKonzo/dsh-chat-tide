// 补偿抽取自测（假模型，不联网）
import { openDatabase } from '../lib/db.js';
import { appendRawLog } from '../lib/events.js';
import { findMissedExtractions, runRepairExtractions } from '../lib/repair.js';

const db = openDatabase(':memory:');
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

const groupMessage = { recordType: 'message', adapter: 'test', peerId: 'p2', conversationKey: 'local:p2', correlationId: 's2:1' };
appendRawLog(db, { ...groupMessage, recordId: 'source-a', userId: 'user-a', payload: '我今天学会了滑冰', metadata: { senderName: '小明' }, observedAt: now - 2 });
appendRawLog(db, { ...groupMessage, recordId: 'source-b', userId: 'user-b', payload: '我今天去杭州了', metadata: { senderName: '小明' }, observedAt: now - 1 });
const grouped = await runRepairExtractions(db, {
  now,
  complete: async (messages) => {
    const text = messages.at(-1).content;
    ok(text.includes('[消息1] 小明 我今天学会了滑冰') && text.includes('[消息2] 小明 我今天去杭州了'), '每条原话带自己的消息编号');
    return JSON.stringify({
      facts: [{ canonicalKey: 'other.current_city', value: '杭州', speaker: '消息2' }],
      events: [{ content: '学会滑冰', speaker: '消息1' }, { content: '归属不明确', speaker: '小明' }],
    });
  },
});
const event = db.prepare("SELECT user_id, source_record_id FROM event WHERE event_type='observation' AND correlation_id='s2:1'").get();
const fact = db.prepare("SELECT user_id, source_record_id FROM fact WHERE canonical_key='other.current_city'").get();
ok(grouped.events === 1 && event?.user_id === 'user-a' && event?.source_record_id === 'source-a', '经历归甲，缺少有效标签的候选不写入');
ok(grouped.facts === 1 && fact?.user_id === 'user-b' && fact?.source_record_id === 'source-b', '事实和证据归乙');

for (const storeFacts of [false, true]) {
  const id = String(storeFacts);
  appendRawLog(db, { ...groupMessage, correlationId: id, recordId: id, observedAt: now,
    payload: '我住在杭州，今天去了西湖 ' + id });
  let settings = {};
  const result = await runRepairExtractions(db, { now, getExtractSettings: () => settings, complete: async () => {
    settings = { storeFacts, storeEvents: !storeFacts };
    return JSON.stringify({ facts: [{ canonicalKey: 'city', value: '杭州' }], events: [{ content: '去了西湖' }] });
  } });
  ok(result.facts === Number(storeFacts) && result.events === Number(!storeFacts), '补抽按模型返回时的开关分类保存 ' + id);
}
db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
