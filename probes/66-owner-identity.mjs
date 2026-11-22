// 主人身份来自配置和私聊绑定，绝不来自记忆内容
import { resolveOwnerIds } from '../lib/scope.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 配置里点名的算主人
const cfg = resolveOwnerIds({ configured: 'A,B' });
ok(cfg.has('A') && cfg.has('B') && cfg.size === 2, '配置里的 openid 生效', [...cfg].join(','));

// 2) 关键：私聊绑定不再是授权。
//    适配器 c2cMode 默认 open，任何人私聊一句都会产生 c2c 绑定；
//    把绑定当主人等于「谁私聊过我谁就是主人」。
const viaBinding = resolveOwnerIds({ bindings: new Map([['s1', { scope: 'c2c', peerId: 'OPENID_STRANGER' }]]) });
ok(viaBinding.size === 0, '私聊绑定不再授予主人身份', String(viaBinding.size));

// 3) 中文逗号、空格、空项都能容忍
const messy = resolveOwnerIds({ configured: ' A ，B,  ,C ' });
ok([...messy].sort().join(',') === 'A,B,C', '分隔符容错', [...messy].join('|'));

// 4) 没有任何配置时就是空集：宁可没人有权限，也不猜
ok(resolveOwnerIds({}).size === 0, '未配置时为空集');
ok(resolveOwnerIds({ configured: '   ' }).size === 0, '空白配置也算空');

// 5) 重复项去重
const dup = resolveOwnerIds({ configured: 'A,A' });
ok(dup.size === 1, '重复项合并', String(dup.size));

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
