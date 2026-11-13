// QQ 入站信封解析：群消息是 [Chat history begins]…[Current message]\n[昵称 (openid)] 正文 (@you)
export const CURRENT_MARK = '[Current message]';

/** 去掉 @提及 标记、末尾的 (@you)，压缩空白。 */
export function cleanBody(text) {
  return String(text ?? '')
    .replace(/<@[0-9A-Fa-f]+>/g, '')
    .replace(/\(@you\)/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 从入站文本里取出“当前这条消息”与发送者。
 * - 有 [Current message]：取其后部分
 * - 没有：整段就是正文（私聊/单条群消息）
 * - 只有历史没有当前消息：current 为空
 */
export function normalizeInbound(text) {
  const raw = String(text ?? '');
  const idx = raw.lastIndexOf(CURRENT_MARK);
  const body = idx >= 0 ? raw.slice(idx + CURRENT_MARK.length) : raw;
  const senderMatch = /^\s*\[([^\]]*?)\s*\(([^)]+)\)\]/.exec(body);
  const sender = senderMatch ? { name: senderMatch[1], id: senderMatch[2] } : null;
  const withoutSender = senderMatch ? body.slice(senderMatch[0].length) : body;
  return {
    current: cleanBody(withoutSender),
    sender,
    hadEnvelope: idx >= 0,
  };
}

/** 宿主/系统注入的杂项文本，不该当用户消息。 */
export function isSystemNoise(text) {
  const t = String(text ?? '').trimStart();
  return (
    t.startsWith('[Chat history begins]') ||
    t.startsWith('The working directory changed') ||
    t.startsWith('[model changed') ||
    t.startsWith('Time sampled while preparing')
  );
}
