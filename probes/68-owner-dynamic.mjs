// 主人来源：显式配置 > qqbot 名单（按语义判断）> 空
import { ownerIdsFromQqbot } from '../lib/scope.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 显式配置优先，压过一切
const explicit = ownerIdsFromQqbot({
  configured: 'OWNER',
  qqbot: { c2cMode: 'open', c2cAllow: ['OTHER'] },
});
ok([...explicit.ids].join(',') === 'OWNER' && explicit.reason === 'configured', '显式配置优先', explicit.reason);

// 2) 没配置时，open 模式下的名单才当权限声明
const openLit = ownerIdsFromQqbot({ qqbot: { c2cMode: 'open', c2cAllow: ['A', 'B'] } });
ok(openLit.ids.size === 2 && openLit.reason === 'qqbot-open-list', 'open 模式下的名单生效', openLit.reason);

// 3) allowlist 模式下的名单是准入清单，不是权限清单
const accessList = ownerIdsFromQqbot({ qqbot: { c2cMode: 'allowlist', c2cAllow: ['A', 'B'] } });
ok(accessList.ids.size === 0 && accessList.reason === 'allowlist-is-access-control', 'allowlist 模式不授产权', accessList.reason);

// 4) 没有 qqbot 插件：不影响，只是空
const noPlugin = ownerIdsFromQqbot({});
ok(noPlugin.ids.size === 0 && noPlugin.reason === 'no-plugin', '没有插件也能跑', noPlugin.reason);

// 5) 名单为空
const empty = ownerIdsFromQqbot({ qqbot: { c2cMode: 'open', c2cAllow: [] } });
ok(empty.ids.size === 0 && empty.reason === 'empty-list', '空名单');

// 6) disabled 模式也不授产权（没有准入含义，但也不该当白名单用）
const disabled = ownerIdsFromQqbot({ qqbot: { c2cMode: 'disabled', c2cAllow: [] } });
ok(disabled.ids.size === 0, 'disabled 模式为空');

// 7) 脏数据不崩
ok(ownerIdsFromQqbot({ qqbot: { c2cMode: 'open', c2cAllow: [null, '  ', 'C'] } }).ids.size === 1, '脏条目被跳过');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
