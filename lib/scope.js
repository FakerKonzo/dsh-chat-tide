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
  if (qq && (mode === 'qq' || mode === 'allowlist')) {
    if (mode === 'allowlist' && !(scopeCfg?.peers ?? []).includes(qq.peerId)) return null;
    return qq;
  }

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
  if (binding.scope !== 'group') {
    return { userId: binding.peerId, senderId: binding.peerId, attribution: 'sender' };
  }
  const m = /^\[([^\]]*?)\s*\(([^)]+)\)\]/.exec(String(text ?? ''));
  if (m) return { userId: m[2], senderId: m[2], attribution: 'sender' };
  return { userId: binding.peerId, senderId: null, attribution: 'peer' };
}
