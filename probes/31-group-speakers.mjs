// 群聊分人：同键不同人不合并、渲染带昵称、规则/self 不混入
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { selectFactsForSpeakers, renderFactBlock } from '../lib/context.js';

const FILE = fileURLToPath(new URL('../.cache/probe-speakers.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const A = 'OPENID_A';
const B = 'OPENID_B';
const base = { assertedBy: 'x', subjectId: 'x', provenanceTier: 'human_explicit' };

// 两个人同键不同值
writeFact(db, { ...base, userId: A, entityId: A, canonicalKey: 'pref.other.coffee', value: '只喝美式' });
writeFact(db, { ...base, userId: B, entityId: B, canonicalKey: 'pref.other.coffee', value: '只喝拿铁' });
// 规则与 self 不应混进群聊事实
writeFact(db, { ...base, userId: A, entityId: A, canonicalKey: 'rule.test.x', value: '一条规矩', subtype: 'rule' });
writeFact(db, { ...base, userId: A, entityId: A, canonicalKey: 'self.test.x', value: '我自己的事', subtype: 'self' });

const rows = selectFactsForSpeakers(db, { userIds: [A, B], limit: 20 });
ok(rows.length === 2, '只取到两人各一条', String(rows.length));
ok(!rows.some((r) => r.subtype === 'rule' || r.subtype === 'self'), '规则与 self 不混入');

const names = new Map([
  [A, '阿甲'],
  [B, '阿乙'],
]);
const block = renderFactBlock(rows, { withSpeaker: true, names, maxChars: 800 });
ok(block.includes('[阿甲]') && block.includes('[阿乙]'), '渲染带发言人');
ok(block.includes('只喝美式') && block.includes('只喝拿铁'), '同键两人都保留（不合并）');
console.log(block.split('\n').slice(2, 5).join('\n'));

// 私聊渲染：不带名字、同键只留一条
const flat = renderFactBlock(rows, { withSpeaker: false, maxChars: 800 });
ok(!flat.includes('[阿甲]'), '私聊不带发言人前缀');
ok((flat.match(/pref\.other\.coffee/g) ?? []).length === 1, '私聊同键只留一条');

// 私聊：默认只看私聊来源，统一会话开启后才看群聊来源
const { writeFact: wf2 } = await import('../lib/facts.js');
wf2(db, { ...base, userId: A, entityId: A, canonicalKey: 'owner.in_group', value: '群里说过的事', scope: 'group' });
wf2(db, { ...base, userId: A, entityId: A, canonicalKey: 'owner.in_private', value: '私聊说过的事', scope: 'private' });
const c2cOff = selectFactsForSpeakers(db, { userIds: [A], limit: 20, allowScopes: ['private', 'unknown', 'local'] });
ok(!c2cOff.some((r) => r.canonicalKey === 'owner.in_group'), '统一会话关闭：私聊看不到群聊来源');
const c2cOn = selectFactsForSpeakers(db, { userIds: [A], limit: 20, allowScopes: ['private', 'group', 'unknown', 'local'] });
ok(c2cOn.some((r) => r.canonicalKey === 'owner.in_group'), '统一会话开启：私聊可以看到群聊来源');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
