// 事实注入要带上"这是谁的事"：私聊也不能只剩没有主语的陈述
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { upsertPerson } from '../lib/people.js';
import { buildInjection } from '../lib/inject.js';
import { renderFactBlock } from '../lib/context.js';
import { appendRawLog } from '../lib/events.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-fact-owner.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const A = 'OPENID_AAAA0000000000000000000001';
const B = 'OPENID_BBBB0000000000000000000002';
upsertPerson(db, { openid: A, nickname: '阿甲' });
upsertPerson(db, { openid: B, nickname: '阿乙' });

const base = { assertedBy: 'x', subjectId: 'x', provenanceTier: 'human_explicit', scope: 'private' };
writeFact(db, { ...base, userId: A, entityId: A, canonicalKey: 'pref.other.coffee', value: '只喝美式', subtype: 'preference' });
writeFact(db, { ...base, userId: B, entityId: B, canonicalKey: 'pref.other.coffee', value: '只喝拿铁', subtype: 'preference' });
writeFact(db, { ...base, userId: A, entityId: A, canonicalKey: 'todo.other.buy_beans', value: '记得买豆子', subtype: 'todo' });

// 1) 私聊（单人对端）：表头要说明这些事实属于谁
const c2c = { adapter: 'qq', peerId: A, scope: 'c2c', conversationKey: `qq:${A}` };
appendRawLog(db, {
  recordId: 'raw-1',
  recordType: 'message',
  adapter: 'qq',
  peerId: A,
  userId: A,
  conversationKey: c2c.conversationKey,
  platform: 'qq',
  observedAt: Date.now(),
  payload: '随便说点什么',
});
const p = buildInjection({ db, binding: c2c, payload: { messages: [] }, cfg: { maxChars: 2000 }, prev: {} });
ok(p.factBlock.includes('都关于 阿甲'), '私聊表头点名事实属于谁', p.factBlock.split('\n')[1]?.slice(-20));
ok(p.factBlock.includes('pref.other.coffee'), '私聊照常注入该人的事实');
ok(!p.factBlock.includes('只喝拿铁'), '私聊不混入另一个人的事实');

// 2) 表头点名时不必每行重复
ok(!p.factBlock.includes('[阿甲]'), '单人表头点名后行内不重复');

// 3) 同一块里出现两个人 → 逐行标，而且两条都在
const rows = [
  { userId: A, canonicalKey: 'pref.other.coffee', subtype: 'preference', value: '只喝美式' },
  { userId: B, canonicalKey: 'pref.other.coffee', subtype: 'preference', value: '只喝拿铁' },
];
const names = new Map([[A, '阿甲'], [B, '阿乙']]);
const both = renderFactBlock(rows, { withSpeaker: true, names, maxChars: 800 });
ok((both.match(/pref\.other\.coffee/g) ?? []).length === 2, '同键两人各留一条');
ok(both.includes('[阿甲]') && both.includes('[阿乙]'), '逐行标出是谁的');

// 4) 没有昵称时不能把 openid 整串带出来
const noName = renderFactBlock([{ userId: A, canonicalKey: 'k.x', subtype: 'profile', value: 'v' }], { withSpeaker: true, names: new Map(), maxChars: 800 });
ok(!noName.includes(A), '缺昵称时不泄露完整 openid');
ok(noName.includes('id:OPENID'), '缺昵称时用短前缀兜底', noName.split('\n')[2] ?? '');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
