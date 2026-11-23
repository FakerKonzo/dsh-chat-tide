// 注入端到端：真实库 + 假 payload，验证群聊/私聊的来源范围与增量
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { appendEvent } from '../lib/events.js';
import { buildInjection } from '../lib/inject.js';
import { upsertPerson } from '../lib/people.js';

const FILE = fileURLToPath(new URL('../.cache/probe-inject-e2e.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const GROUP = 'GROUP1';
const USER = 'U1';
const base = { userId: USER, entityId: USER, assertedBy: USER, subjectId: USER, provenanceTier: 'human_explicit' };
const put = (key, value, scope) => writeFact(db, { ...base, canonicalKey: key, subtype: 'profile', value, scope });

put('owner.group_project', '群里说过的项目', 'group');
put('owner.private_addr', '私聊说过的地址', 'private');
upsertPerson(db, { openid: USER, nickname: '小明' });
// 真实库里发言人来自流水账；这里补两条，让群聊能按发言人取事实
const insRaw = db.prepare(
  "INSERT INTO raw_log(record_id, record_type, peer_id, user_id, conversation_key, platform, dedupe_key, observed_at, payload) VALUES (?,?,?,?,?,?,?,?,?)",
);
insRaw.run('r1', 'message', 'GROUP1', USER, 'qq:GROUP1', 'qq', 'd1', Date.now(), '群里的消息');
insRaw.run('r2', 'message', 'GROUP1', USER, 'qq:U1', 'qq', 'd2', Date.now(), '私聊的消息');

const payload = { messages: [{ content: [{ type: 'text', text: '你好' }] }] };
const groupBinding = { scope: 'group', peerId: GROUP, conversationKey: `qq:${GROUP}` };
const c2cBinding = { scope: 'c2c', peerId: USER, conversationKey: `qq:${USER}` };

// 1) 群聊默认：只有群聊来源，且带发言人名字
const g1 = buildInjection({ db, binding: groupBinding, payload, cfg: {} });
ok(g1.factBlock.includes('owner.group_project'), '群聊注入含群聊事实');
ok(!g1.factBlock.includes('owner.private_addr'), '群聊默认不含私聊事实');
// 一位发言人时表头点名，多位发言人时逐行标——两种都算"带发言人"
ok(g1.factBlock.includes('[小明]') || g1.factBlock.includes('都关于 小明'), '群聊事实带发言人', g1.factBlock.split('\n')[2] ?? '');

// 2) 只开统一会话，不开屏蔽：仍不含私聊
const g2 = buildInjection({ db, binding: groupBinding, payload, cfg: { unifySessions: true } });
ok(!g2.factBlock.includes('owner.private_addr'), '只开统一会话仍不含私聊事实');

// 3) 两个都放开：含私聊
const g3 = buildInjection({
  db,
  binding: groupBinding,
  payload,
  cfg: { unifySessions: true, groupExcludePrivate: false },
});
ok(g3.factBlock.includes('owner.private_addr'), '两个开关都放开后群里含私聊事实');

// 4) 私聊默认不含群聊事实，开统一会话后含
const p1 = buildInjection({ db, binding: c2cBinding, payload, cfg: {} });
ok(p1.factBlock.includes('owner.private_addr'), '私聊注入含私聊事实');
ok(!p1.factBlock.includes('owner.group_project'), '私聊默认不含群聊事实');
const p2 = buildInjection({ db, binding: c2cBinding, payload, cfg: { unifySessions: true } });
ok(p2.factBlock.includes('owner.group_project'), '私聊开统一会话后含群聊事实');

// 5) 经历：本会话必带，跨会话按开关
appendEvent(db, {
  eventId: 'ev-own',
  eventType: 'observation',
  content: '今天聊了屋顶光伏',
  occurredAt: Date.now(),
  conversationKey: `qq:${GROUP}`,
  userId: USER,
  scope: 'group',
});
const e1 = buildInjection({ db, binding: groupBinding, payload, cfg: {} });
ok(e1.eventBlock.includes('屋顶光伏'), '本会话经历必带');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
