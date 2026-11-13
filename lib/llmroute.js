// LLM 兜底：只判灰区（ambient 的相关性），只允许三种输出。
export const FALLBACK_PROMPT = `你是群聊相关性判定器。给定一条群消息和最近上下文，判断这条消息是否与"这个助手"相关（例如在找它、问它、聊它参与过的话题）。
只输出一个词：relevant_ambient 或 irrelevant_ambient 或 uncertain。
拿不准就输出 uncertain。不要解释，不要输出别的字。`;

export const ALLOWED = new Set(['relevant_ambient', 'irrelevant_ambient', 'uncertain']);

const LABEL_RE = {
  // 注意：irrelevant_ambient 含 relevant_ambient 子串，正则用边界隔离，且先判 irrelevant
  irrelevant_ambient: /(^|[^a-z_])irrelevant_ambient([^a-z_]|$)/,
  relevant_ambient: /(^|[^a-z_])relevant_ambient([^a-z_]|$)/,
  uncertain: /(^|[^a-z_])uncertain([^a-z_]|$)/,
};

/** 从模型输出里取标签；不认识就降级 uncertain（保守）。 */
export function parseLabel(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (LABEL_RE.irrelevant_ambient.test(text)) return 'irrelevant_ambient';
  if (LABEL_RE.relevant_ambient.test(text)) return 'relevant_ambient';
  if (LABEL_RE.uncertain.test(text)) return 'uncertain';
  if (/不相关|无关|不涉及/.test(text)) return 'irrelevant_ambient';
  if (/相关|有关/.test(text)) return 'relevant_ambient';
  return 'uncertain';
}

/**
 * 跑一次兜底判定。complete: async (messages) => string。
 * 失败或异常一律返回 uncertain（不放大影响面）。
 */
export async function classifyByLlm({ complete, text, context = '', maxChars = 600 }) {
  const user = [context ? `最近上下文：\n${context.slice(0, maxChars)}` : '', `当前消息：\n${String(text ?? '').slice(0, 1000)}`]
    .filter(Boolean)
    .join('\n\n');
  try {
    const raw = await complete([
      { role: 'system', content: FALLBACK_PROMPT },
      { role: 'user', content: user },
    ]);
    return parseLabel(raw);
  } catch {
    return 'uncertain';
  }
}
