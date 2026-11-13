// preset 作用域自测（不依赖宿主）
import { resolveSession } from '../lib/scope.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const session = (id, agentPreset, cwd = 'D:/x') => ({ id, agentPreset, cwd });

// 1) preset 模式：只认列出的 preset
const scope = { mode: 'preset', presets: ['tide'] };
ok(resolveSession(session('s1', 'tide'), scope) !== null, '目标 preset 绑定成功');
ok(resolveSession(session('s2', 'standard'), scope) === null, '默认 preset 不绑定');
ok(resolveSession(session('s3', undefined), scope) === null, '无 preset 的不绑定');
ok(resolveSession(session('s4', 'tide'), { mode: 'preset', presets: [] }) === null, '名单为空时不绑定任何人');

// 2) off 模式全不绑定
ok(resolveSession(session('s1', 'tide'), { mode: 'off' }) === null, 'off 模式不介入');

// 3) workspace 模式仍按目录匹配
const ws = { mode: 'workspace', cwd: 'D:/x' };
ok(resolveSession(session('s1', 'standard', 'D:/x'), ws) !== null, 'workspace 命中');
ok(resolveSession(session('s1', 'standard', 'D:/y'), ws) === null, 'workspace 未命中');
ok(resolveSession(session('s1', 'standard', 'D:/x'), { mode: 'workspace', cwd: 'D:/y' }) === null, 'workspace 目录不同不绑定');

// 4) all 模式
ok(resolveSession(session('s1', 'standard'), { mode: 'all' }) !== null, 'all 模式绑定');

// 5) 绑定里带 adapter/conversationKey
const b = resolveSession(session('s1', 'tide'), scope);
ok(b.adapter === 'local' && b.conversationKey === 'local:s1', '本地绑定结构正确', JSON.stringify(b));

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
