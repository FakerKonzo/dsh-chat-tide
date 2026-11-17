// 复审四条：证据记录跟人、重名可区分、候选够宽、截断不算已发
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { appendEvent } from '../lib/events.js';
import { buildInjection, diffInjection } from '../lib/inject.js';
import { labelSpeakers } from '../lib/extract.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-review2.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const NOW = Date.now();
const HERE = 'qq:group:HERE';
const ELSE = 'qq:c2c:ELSE';

// 1) 重名标签：两个人同名时能区分到具体那一条
const dup = labelSpeakers([
  { name: '小明', userId: 'A', recordId: 'ra' },
  { name: '小明', userId: 'B', recordId: 'rb' },
]);
ok(dup[0].label === '小明' && dup[1].label === '小明#2', '重名时分出第一、第二条', dup.map((d) => d.label).join(','));
ok(dup[0].userId === 'A' && dup[1].userId === 'B', '标签仍然指回各自的人');
const uniq = labelSpeakers([{ name: '阿甲' }, { name: '阿乙' }]);
ok(uniq[0].label === '阿甲' && uniq[1].label === '阿乙', '不重名时不加后缀');

// 2) 当前会话把 recent 名额占满，且同会话命中在前：跨会话那条仍要能被找到
for (let i = 0; i < 6; i++) {
  appendEvent(db, {
    eventId: `here-${i}`,
    eventType: 'conversation',
    content: `杭州天气闲聊第 ${i} 次`,
    conversationKey: HERE,
    occurredAt: NOW - i * 60_000,
    scope: 'group',
  });
}
appendEvent(db, {
  eventId: 'there-1',
  eventType: 'observation',
  content: '主人下周三去杭州出差',
  conversationKey: ELSE,
  occurredAt: NOW - 3 * 86_400_000,
  scope: 'private',
});
const binding = { adapter: 'qq', peerId: 'P', scope: 'group', conversationKey: HERE };
const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: '杭州' }] }] };
const cfg = { unifySessions: true, groupExcludePrivate: false, recentDays: 7, eventLimit: 3 };
const built = buildInjection({ db, binding, payload, cfg, prev: {} });
ok(built.events.some((e) => e.eventId === 'there-1'), '同会话命中挤在前面时，跨会话相关经历仍进得来', built.events.map((e) => e.eventId).join(','));

// 3) 预算截掉的经历不能记成已发送
const many = Array.from({ length: 6 }, (_, i) => ({
  eventId: `e-${i}`,
  eventType: 'observation',
  content: `很长的一条经历内容第 ${i} 条，用来把预算撑爆`,
  occurredAt: NOW,
  speakerName: null,
}));
const diff = diffInjection({
  built: { ruleBlock: '', factBlock: '', eventBlock: '', events: many },
  prev: { eventIds: [] },
  cfg: { eventMaxChars: 80 },
});
const sentCount = (diff.eventDelta.match(/- \(/g) ?? []).length;
ok(sentCount > 0 && sentCount < many.length, '预算只放进去一部分', `${sentCount}/${many.length}`);
ok(diff.eventIds.length === sentCount, '只把真正渲染进去的记为已发送', `${diff.eventIds.length} vs ${sentCount}`);

// 没发出去的下次还会尝试
const next = diffInjection({
  built: { ruleBlock: '', factBlock: '', eventBlock: '', events: many },
  prev: { eventIds: diff.eventIds },
  cfg: { eventMaxChars: 80 },
});
ok(next.eventDelta !== '' && next.eventIds.length > diff.eventIds.length, '下一轮继续送没发出去的');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
