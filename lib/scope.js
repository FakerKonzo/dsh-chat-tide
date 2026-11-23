// 作用域与身份：QQ 会话映射 + 本地会话合成绑定 + preset 过滤。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const QQ_PREFS = process.env.CM_QQ_PREFS ?? join(homedir(), '.dsh-qqbot', 'model-prefs.json');

let prefsCache = null;
let prefsAt = 0;

/** 读 QQ 插件的对端映射（只读；失败返回空表，不影响主流程）。 */
export function readQqBindings() {
  try {
    const raw = readFileSync(QQ_PREFS, 'utf8');
    const now = Date.now();
    if (prefsCache && now - prefsAt < 5000) return prefsCache;
    const parsed = JSON.parse(raw);
    const map = new Map();
    for (const [key, sessionId] of Object.entries(parsed.sessionIds ?? {})) {
      const [, , scope, peerId] = key.split(':');
      if (!peerId || !sessionId) continue;
      map.set(sessionId, { adapter: 'qq', peerId, scope, conversationKey: `qq:${peerId}` });
    }
    prefsCache = map;
    prefsAt = now;
    return map;
  } catch {
    return new Map();
  }
}

function localBinding(sessionId) {
  return { adapter: 'local', peerId: sessionId, scope: 'local', conversationKey: `local:${sessionId}` };
}

/**
 * 解析一个会话的绑定。
 * scopeCfg:
 *   mode: 'off' | 'all' | 'qq' | 'allowlist' | 'workspace' | 'preset' | 'sessions'
 *   peers: string[]        allowlist 模式的对端白名单
 *   cwd: string            workspace 模式匹配的会话工作目录
 *   presets: string[]      preset 模式匹配的 agentPreset id
 * sessionInfo: { id, cwd?, agentPreset? }
 */
export function resolveSession(sessionInfo, scopeCfg) {
  if (!sessionInfo?.id) return null;
  const mode = scopeCfg?.mode ?? 'off';
  if (mode === 'off') return null;

  // 子代理默认不介入（可显式打开）
  if (sessionInfo.origin === 'subagent' && scopeCfg?.includeSubagents !== true) return null;

  // 手动点名会话：优先级最高
  const manual = scopeCfg?.sessionIds ?? [];
  if (manual.includes(sessionInfo.id)) {
    const qqHit = readQqBindings().get(sessionInfo.id);
    return qqHit ?? localBinding(sessionInfo.id);
  }

  // 只看 QQ 会话（含群与私聊）
  if (mode === 'qq') {
    return readQqBindings().get(sessionInfo.id) ?? null;
  }

  // preset 模式：只认显式列出的 preset，默认预设完全不受影响
  if (mode === 'preset') {
    const want = scopeCfg?.presets ?? [];
    if (!want.length) return null;
    if (!want.includes(sessionInfo.agentPreset)) return null;
  }

  // 跟随 dsh-qqbot：QQ 会话 + 与它同一工作区的本地会话
  if (mode === 'follow') {
    const qqHit = readQqBindings().get(sessionInfo.id);
    if (qqHit) return qqHit;
    const followCwd = scopeCfg?.followCwd;
    if (followCwd && sessionInfo.cwd && sessionInfo.cwd === followCwd) return localBinding(sessionInfo.id);
    return null;
  }

  const qq = readQqBindings().get(sessionInfo.id);
  if (qq && mode === 'qq') return qq;

  if (mode === 'all' || mode === 'preset') return localBinding(sessionInfo.id);
  if (mode === 'workspace' && scopeCfg?.cwd && sessionInfo.cwd && sessionInfo.cwd === scopeCfg.cwd) {
    return localBinding(sessionInfo.id);
  }
  if (mode === 'sessions') return null;
  return null;
}

/** 兼容旧调用：只给 sessionId 时按 QQ 映射判断。 */
export function resolveBinding(sessionId, scopeCfg) {
  const mode = scopeCfg?.mode ?? 'off';
  if (mode === 'off') return null;
  const qq = readQqBindings().get(sessionId);
  if (!qq) return null;
  if (mode === 'allowlist' && !(scopeCfg?.peers ?? []).includes(qq.peerId)) return null;
  return qq;
}

/** 从群消息正文前缀 `[昵称 (openid)]` 解析发送者；私聊/本地会话归 peer。 */
export function parseSender(text, binding) {
  if (!binding) return { userId: null, senderId: null, attribution: 'peer' };
  // 正文现在群聊、私聊都带 [昵称 (openid)]，一律按标签认人：
  // 私聊直接取绑定的 peerId 会在同一个人多个会话时归错。
  const tag = /^\[([^\]]*?)\s*\(([^)]+)\)\]/.exec(String(text ?? ''));
  if (tag) return { userId: tag[2], senderId: tag[2], attribution: 'sender' };
  // 没有标签时：私聊就认绑定的对端，群聊按 peer 处理（别瞎猜是谁）
  if (binding.scope !== 'group') return { userId: binding.peerId, senderId: binding.peerId, attribution: 'sender' };
  return { userId: binding.peerId, senderId: null, attribution: 'peer' };
}

/** 由会话键推断来源场景：QQ 群/私聊，或本地会话。 */
export function conversationScope(conversationKey) {
  const key = String(conversationKey ?? '');
  for (const binding of readQqBindings().values()) {
    if (binding.conversationKey === key) return binding.scope === 'group' ? 'group' : 'private';
  }
  if (key.startsWith('local:')) return 'local';
  return 'unknown';
}

/**
 * 主人身份只认显式配置里的 openid。
 *
 * 两次踩过的坑：一是从 `owner.*` 事实反推——写条事实就能拿权限；
 * 二是把私聊绑定当授权——适配器的 c2cMode 默认是 open，**任何人私聊一句就自动有绑定**，
 * 于是「谁私聊过我」变成了「谁是主人」。
 * 权限只能来自人明确写下的配置。
 */
export function resolveOwnerIds({ configured = '' } = {}) {
  const ids = new Set();
  for (const raw of String(configured ?? '').split(/[,，\s]+/)) {
    const id = raw.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * 从 qqbot 的配置推断主人清单。返回 { ids, reason }，reason 用来解释为什么空。
 *
 * 语义判断：`c2cMode === 'allowlist'` 时 c2cAllow 是**访问控制清单**（能私聊的人），
 * 拿它授产权等于把「允许聊天」升级成「主人」——所以那种情况不采用。
 * `c2cMode === 'open'` 时这个清单不参与准入，它是人手动写下的名单，
 * 才当作权限声明。两种含义不能混。
 */
export function ownerIdsFromQqbot({ configured = '', qqbot = null } = {}) {
  const ids = new Set();
  for (const raw of String(configured ?? '').split(/[,，\s]+/)) {
    const id = raw.trim();
    if (id) ids.add(id);
  }
  if (ids.size) return { ids, reason: 'configured' };
  const mode = String(qqbot?.c2cMode ?? '');
  const list = Array.isArray(qqbot?.c2cAllow) ? qqbot.c2cAllow : [];
  if (!list.length) return { ids, reason: qqbot ? 'empty-list' : 'no-plugin' };
  if (mode === 'allowlist') {
    // 准入清单通常有多人，那时它不说明谁是主人。只有一个成员时，
    // 那基本就是主人本人把自己加进了白名单——这种情况才采用。
    const single = list.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (single.length !== 1) return { ids, reason: 'allowlist-is-access-control' };
    ids.add(single[0]);
    return { ids, reason: 'qqbot-allowlist-single' };
  }
  for (const raw of list) {
    const id = String(raw ?? '').trim();
    if (id) ids.add(id);
  }
  return { ids, reason: ids.size ? 'qqbot-open-list' : 'empty-list' };
}
