// 聊天预设的清单：结构对不对、该留的留、该砍的砍
import { chatPresetDefinition, registerChatPreset, CHAT_PRESET_ID } from '../lib/preset.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const win = chatPresetDefinition({ platform: 'win32' });
const linux = chatPresetDefinition({ platform: 'linux' });

// 1) 基本形状
ok(win.id === CHAT_PRESET_ID && CHAT_PRESET_ID === 'tide-chat', '预设 id 固定');
ok(Array.isArray(win.plugins) && win.plugins.length > 6, '插件清单非空', String(win.plugins.length));
ok(win.plugins.every((p) => typeof p.id === 'string' && typeof p.name === 'string'), '每行都有 id 和包名');

const ids = win.plugins.map((p) => p.id);
ok(new Set(ids).size === ids.length, 'id 不重复');

// 2) 该有的能力
for (const want of ['persona', 'agent-instructions', 'tool-fs', 'compaction', 'persistent-shell', 'tool-schedule', 'skill-filesystem', 'tool-skill', 'time-context', 'tool-fs-search']) {
  ok(ids.includes(want), `带上了 ${want}`);
}
// 3) 该砍的编排工具
for (const gone of ['plan-mode', 'delegation', 'tool-jobs', 'tool-goal']) {
  ok(!ids.includes(gone), `没有 ${gone}`);
}

// 4) persona 绝不能是 complete，否则会把工作区文档挤掉
const persona = win.plugins.find((p) => p.id === 'persona');
ok(persona?.config?.complete !== true, 'persona 不声明 complete');
ok(persona?.config?.includeRuntimeContext === false, 'persona 关掉运行时上下文');

// 5) 文件读写要有（它得能改自己的预设和记忆）
const fsRow = win.plugins.find((p) => p.id === 'tool-fs');
ok(fsRow?.config?.read === true && fsRow?.config?.write === true && fsRow?.config?.edit === true, '文件读写编辑都开');

// 6) 平台差异：Windows 只启 pwsh 两条
const shellWin = win.plugins.find((p) => p.id === 'persistent-shell').config;
const shellLinux = linux.plugins.find((p) => p.id === 'persistent-shell').config;
const dis = (list, id) => list.find((p) => p.id === id)?.disabled === true;
ok(!shellWin.some((p) => /bash/.test(p.id)), 'Windows 不挂 bash（没有可靠的 bash 可用）');
ok(!dis(shellWin, 'persistent-pwsh'), 'Windows 启用 pwsh（只留持久会话一条，少一份启动风险）');
ok(!dis(shellLinux, 'terminal-bash') && dis(shellLinux, 'persistent-pwsh'), 'Linux 反过来');

// 7) 注册：服务缺失或抛错都要安静失败，不能把插件带崩
let called = 0;
const fake = {
  async register(def) {
    called += 1;
    if (def.id !== CHAT_PRESET_ID) throw new Error('bad id');
    return async () => {
      called += 10;
    };
  },
};
const dispose = await registerChatPreset(fake);
ok(typeof dispose === 'function', '注册返回注销函数');
await dispose();
ok(called === 11, '注销被调用到', String(called));
ok((await registerChatPreset(null)) === null, '服务缺失时返回 null');
const boom = {
  async register() {
    throw new Error('duplicate');
  },
};
ok((await registerChatPreset(boom)) === null, '注册失败时返回 null 而不是抛');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
