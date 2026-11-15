// 标识脱敏：把长串 id/openid 之类换成占位，避免写进关注点或事实值
const LONG_ID = /\b[0-9A-Za-z_-]{24,}\b/g;
const ENVELOPE = /\[[^\]\n]{1,32}?\s*\(([0-9A-Za-z]{10,})\)\]/g;
const MENTION = /<@[^>]{1,64}>/g;

/** 去掉聊天信封，并把长串标识替换成 <id>。 */
export function scrubIdentifiers(text) {
  let t = String(text ?? '');
  t = t.replace(ENVELOPE, ' ');
  t = t.replace(MENTION, ' ');
  t = t.replace(LONG_ID, '<id>');
  return t.replace(/\s+/g, ' ').trim();
}

/** 体检用：找出仍然含长串标识的文本。 */
export function findIdentifierLeaks(text) {
  const t = String(text ?? '');
  const hits = [];
  const re = /\b[0-9A-Fa-f]{24,}\b/g;
  let m;
  while ((m = re.exec(t))) hits.push(m[0]);
  return hits;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * 群聊里工具报错的外显文本：只留「哪个工具、失败了」，原始报错不进模型上下文。
 * 错误码是短标识符时保留，方便它判断要不要换路子；代码/堆栈/路径一律不留。
 */
export function scrubToolErrorText(name, code) {
  const tool = String(name ?? '').trim() || '工具';
  const c = String(code ?? '').trim();
  return SAFE_CODE.test(c)
    ? `工具 ${tool} 执行失败（${c}；原始报错已隐藏）`
    : `工具 ${tool} 执行失败（原始报错已隐藏）`;
}

/**
 * tools/post-execute 的决策：满足「开关开 + 是工具失败 + 会话是群聊」才换文本。
 * 其余情况原样放行。纯函数，方便直接测。
 */
export function hideToolErrorDecision({ decision, result, toolName, binding, enabled }) {
  if (enabled === false) return decision;
  if (!decision || decision.kind !== 'accept') return decision;
  if (!result?.isError) return decision;
  if (!binding || binding.scope !== 'group') return decision;
  const text = scrubToolErrorText(toolName, result?.error?.info?.code ?? result?.error?.info?.name);
  return {
    kind: 'accept',
    content: [{ type: 'text', text }],
    // 内层监听器塞的上下文不能丢
    ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
  };
}
