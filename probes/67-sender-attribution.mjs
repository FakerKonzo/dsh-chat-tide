// 群聊和私聊都按正文标签认人
import { parseSender } from '../lib/scope.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const group = { scope: 'group', peerId: 'GROUP_KEY' };
const c2c = { scope: 'c2c', peerId: 'PEER_ID' };

const g = parseSender('[小明 (OPENID_A)] 早', group);
ok(g.userId === 'OPENID_A' && g.senderId === 'OPENID_A', '群聊按标签认人', g.userId);

// 私聊现在正文也带标签：优先按标签，而不是绑定的 peerId
const d = parseSender('[Aix (OPENID_OWNER)] 在吗', c2c);
ok(d.userId === 'OPENID_OWNER', '私聊也按标签认人', d.userId);

// 私聊没有标签时退回绑定对端（老消息兼容）
const d2 = parseSender('在吗', c2c);
ok(d2.userId === 'PEER_ID' && d2.attribution === 'sender', '私聊无标签退回对端');

// 群聊没有标签时不瞎猜是谁
const g2 = parseSender('早', group);
ok(g2.userId === 'GROUP_KEY' && g2.senderId === null, '群聊无标签不猜发送人');

// 昵称里带括号也不能把 openid 取错
// 昵称里带括号：id 取的是紧贴右括号的那一组，这是对的
const weird = parseSender('[a (b) c (OPENID_X)] hi', group);
ok(weird.userId === 'OPENID_X', '昵称含括号也能取对 openid', weird.userId);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
