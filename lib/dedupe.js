// 入站判重：有平台 msgId 用 msgId（强幂等），没有才退内容哈希 + 时间窗。
import { createHash } from 'node:crypto';

export const DEFAULT_WINDOW_MS = 10_000;

export function contentHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex');
}

/**
 * 从消息文本里嗅探透传的 msgId 前缀 `[msgid:ROBOT1.0_xxx]`。
 * 传输层若将来把平台 msgId 带进正文，本函数即可自动启用强幂等，零改动。
 */
export function sniffPlatformMsgId(text) {
  const m = /\[msgid:([^\]\s]+)\]/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * 判重键。
 * - platformMsgId 存在：`msg:<adapter>:<peer>:<id>` —— 同一条平台消息永远同键；
 * - 不存在：`hash:<adapter>:<peer>:<sha1>:<窗口序号>` —— 只在同一时间窗内合并。
 */
export function dedupeKey({ adapter, peerId, platformMsgId, text, observedAt, windowMs = DEFAULT_WINDOW_MS }) {
  const id = platformMsgId ?? sniffPlatformMsgId(text);
  if (id) return `msg:${adapter}:${peerId}:${id}`;
  const bucket = Math.floor(observedAt / windowMs);
  return `hash:${adapter}:${peerId}:${contentHash(text)}:${bucket}`;
}
