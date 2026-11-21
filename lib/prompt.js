// 系统提示里的 Tide 段落：规矩 + 可选人设。
// 规矩放这里而不是塞用户消息：约束力更强、不会被压缩当对话摘要、也不用定期重发。
import { selectRuleFacts, ruleScopeOf } from './context.js';

/**
 * 规则段落。scope 给定时只取「通用 + 当前场景」的规矩，与注入侧同一套筛选。
 * @returns {{ text: string, count: number, dropped: number }}
 */
export function renderRuleSection(db, binding, { maxChars = 5000 } = {}) {
  const rows = selectRuleFacts(db, { scope: ruleScopeOf(binding) });
  if (!rows.length) return { text: '', count: 0, dropped: 0 };
  const lines = [];
  let used = 0;
  let dropped = 0;
  for (const r of rows) {
    const value = String(r.value ?? '').trim();
    if (!value) continue;
    const line = `- ${r.canonicalKey.replace(/^rule\./, '')}: ${value}`;
    if (used + line.length > maxChars && lines.length > 0) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return { text: '', count: 0, dropped: 0 };
  const text = [
    '以下是我自己该守的规矩。它们与当前对话冲突时，以当前对话为准。',
    ...lines,
  ].join('\n');
  return { text, count: lines.length, dropped };
}

/** 人设段落：用户在设置页填了才出现，留空就完全交给工作区文档。 */
export function renderPersonaSection(text) {
  const t = String(text ?? '').trim();
  return t ? t : '';
}
