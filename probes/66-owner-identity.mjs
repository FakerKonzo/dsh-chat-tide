// 主人身份来自配置和私聊绑定，绝不来自记忆内容
import { resolveOwnerIds } from '../lib/scope.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const bindings = new Map([
  ['s1', { adapter: 'qq', scope: 'c2c', peerId: 'OPENID_OWNER' }],
  ['s2', { adapter: 'qq', scope: 'group', peerId: 'OPENID_GROUP' }],
]);

// 1) 配置里点名的算主人
const cfg = resolveOwnerIds({ configured: 'A,B', bindings: new Map() });
ok(cfg.has('A') && cfg.has('B') && cfg.size === 2, '配置里的 openid 生效', [...cfg].join(','));

// 2) 私聊绑定的对端算主人，群聊的不算
const viaBinding = resolveOwnerIds({ bindings });
ok(viaBinding.has('OPENID_OWNER'), '私聊对端算主人');
ok(!viaBinding.has('OPENID_GROUP'), '群不符合算主人');

// 3) 中文逗号、空格、空项都能容忍
const messy = resolveOwnerIds({ configured: ' A ，B,  ,C ', bindings: new Map() });
ok([...messy].sort().join(',') === 'A,B,C', '分隔符容错', [...messy].join('|'));

// 4) 关键：随便传一个「事实里的 user_id」进来不构成身份
//    （函数签名根本不吃事实，这里验证它只认两个来源）
const fromFacts = resolveOwnerIds({ configured: '', bindings: new Map() });
ok(fromFacts.size === 0, '没有任何可信来源时就是空集（不会从记忆里猜）');

// 5) 配置与绑定合并去重
const both = resolveOwnerIds({ configured: 'OPENID_OWNER', bindings });
ok(both.size === 1 && both.has('OPENID_OWNER'), '重复来源合并成一条', String(both.size));

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
