// 聊天预设：以宿主极简预设为模板，只留聊天要用的东西。
// 由插件在运行时注册，不写进用户的 profile 补丁——配置随插件版本走，装完即有用。
//
// 取舍（都写在清单旁边，改的时候别丢）：
// - persona 不用 complete：用了就是「整份系统提示我提供」，AGENTS/SOUL 会被挤掉。
// - 挂 agent-instructions：否则工作区 AGENTS.md 不加载。
// - 留 shell：逛小黑盒走 cloakbrowser-cli，没有 shell 干不了。
// - 不挂 plan-mode / delegation / jobs / goal：编码场景的编排工具，聊天每轮白付 schema。

/** 预设 id，外面切换会话时用的就是它。 */
export const CHAT_PRESET_ID = 'tide-chat';

/**
 * 清单本体。Windows 上只启 pwsh 两条终端，等价的 YAML 用的是 `!!js` 表达式，
 * 这里改成运行时算，避免依赖 YAML 扩展标签。
 */
export function chatPresetDefinition({ platform = process.platform } = {}) {
  const win = platform === 'win32';
  return {
    id: CHAT_PRESET_ID,
    name: 'Tide 聊天',
    description: '聊天场景的装配：读写文件、终端、定时任务、技能、时间与文件搜索；人格交给工作区文档，不加载编码场景的编排工具。',
    order: 9,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: '', includeRuntimeContext: false },
      },
      {
        id: 'agent-instructions',
        name: '@deepseek-ai/dsh-agent-instructions',
        config: { maxBytes: 65536 },
      },
      {
        id: 'tool-fs',
        name: '@deepseek-ai/dsh-tool-fs',
        config: { read: true, readImage: true, write: true, edit: true, applyPatch: false },
      },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true },
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        ],
      },
      {
        id: 'persistent-shell',
        name: 'cordis:group',
        group: true,
        isolate: { terminals: true },
        config: [
          { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
          { id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash', disabled: win, config: { timeoutMs: 300000 } },
          {
            id: 'persistent-bash',
            name: '@deepseek-ai/dsh-tool-bash-persistent',
            disabled: win,
            config: { timeoutMs: 300000 },
          },
          {
            id: 'terminal-pwsh',
            name: '@deepseek-ai/dsh-terminal-bash',
            disabled: !win,
            config: { shellDialect: 'pwsh', timeoutMs: 300000 },
          },
          {
            id: 'persistent-pwsh',
            name: '@deepseek-ai/dsh-tool-pwsh-persistent',
            disabled: !win,
            config: { timeoutMs: 300000 },
          },
        ],
      },
      { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobPaths: false, sampleOverCapGlobResults: false },
      },
    ],
  };
}

/**
 * 注册这个预设。宿主没装 agentPresets 服务时安静跳过，不影响插件其余部分。
 * @returns {Promise<(() => Promise<void>) | null>}
 */
export async function registerChatPreset(registry, { log = null, platform = process.platform } = {}) {
  if (!registry || typeof registry.register !== 'function') {
    log?.('warn', 'preset', { error: 'agentPresets 不可用，跳过预设注册' });
    return null;
  }
  try {
    const dispose = await registry.register(chatPresetDefinition({ platform }));
    return dispose ?? null;
  } catch (err) {
    log?.('warn', 'preset', { error: String(err?.message ?? err) });
    return null;
  }
}
