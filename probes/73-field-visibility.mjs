// 条件字段的显示规则：一层与两层依赖都要对
import { GROUPS, fieldVisible, DEFAULTS } from '../lib/schema.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const field = (key) => GROUPS.flatMap((g) => g.fields).find((f) => f[0] === key);
const vis = (key, values) => fieldVisible(field(key), { ...DEFAULTS, ...values });

// 1) 作用域：只有对应取值才出现
ok(vis('scope.cwd', { 'scope.mode': 'workspace' }) === true, '指定工作区时出现路径');
ok(vis('scope.cwd', { 'scope.mode': 'follow' }) === false, '跟随 QQBot 时不出现路径');
ok(vis('scope.sessionIds', { 'scope.mode': 'sessions' }) === true, '指定会话时出现选择器');
ok(vis('scope.sessionIds', { 'scope.mode': 'follow' }) === false, '跟随 QQBot 时不出现选择器');

// 2) 记事总开关下的三个细分
ok(vis('extract.storeFacts', { 'extract.enabled': false }) === false, '关掉记事时细分隐藏');
ok(vis('extract.storeFacts', { 'extract.enabled': true }) === true, '打开记事时细分出现');

// 3) 两层依赖：关掉回答前找记忆，跨聊天和跳过私聊都要藏
const noLookup = { 'features.contextInject': false, 'context.unifySessions': true };
ok(vis('context.unifySessions', noLookup) === false, '不再找记忆时跨聊天隐藏');
ok(vis('context.groupExcludePrivate', noLookup) === false, '不再找记忆时跳过私聊也隐藏');

// 4) 跨聊天关掉时，跳过私聊仍隐藏（第二层依赖）
ok(vis('context.groupExcludePrivate', { 'features.contextInject': true, 'context.unifySessions': false }) === false, '跨聊天关闭时跳过私聊隐藏');
ok(vis('context.groupExcludePrivate', { 'features.contextInject': true, 'context.unifySessions': true }) === true, '两层都开时出现');

// 5) 布尔与字符串都能匹配（前端传的是真布尔）
ok(vis('extract.storeFacts', { 'extract.enabled': 'true' }) === true, '字符串 true 也能匹配');
ok(vis('extract.storeFacts', { 'extract.enabled': false }) === false, '布尔 false 能匹配');

// 6) 没有条件的字段永远显示
ok(vis('owner.ids', {}) === true, '无条件的字段始终显示');
ok(vis('features.contextInject', {}) === true, '开关自身永远显示');

// 7) 时间字段跟着安静时段开关
ok(vis('routing.quietStart', { 'routing.quietEnabled': false }) === false, '安静时段关闭时不显示时间');
ok(vis('routing.quietStart', { 'routing.quietEnabled': true }) === true, '安静时段打开时显示时间');

// 8) 人设文本只在自定义时出现
ok(vis('persona.text', { 'persona.mode': 'off' }) === false, '跟随文档时不显示文本框');
ok(vis('persona.text', { 'persona.mode': 'custom' }) === true, '自定义时显示文本框');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
