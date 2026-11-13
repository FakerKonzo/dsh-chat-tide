// 路由：标签推断 + 相似度阈值判定（纯函数，score 由调用方算）。
export const classRank = { direct: 4, command: 3, ambient: 2, noise: 1 };

/** 一级标签：只做插件内部推断，不假设平台语义。 */
export function classify({ text, isMentioned = false, isReplyToBot = false, fromSelf = false, isSystem = false }) {
  if (fromSelf || isSystem) return 'noise';
  if (/^\s*\/\S+/.test(String(text ?? ''))) return 'command';
  if (isMentioned || isReplyToBot) return 'direct';
  return 'ambient';
}

/** 二级判定：ambient 才用。返回 relevant_ambient | irrelevant_ambient | uncertain。 */
export function decideAmbient({ top1 = 0, top2 = 0, high = 0.55, low = 0.42, marginThreshold = 0.02 } = {}) {
  const margin = top1 - top2;
  if (top1 >= high && margin >= marginThreshold) return { label: 'relevant_ambient', top1, margin };
  if (top1 < low) return { label: 'irrelevant_ambient', top1, margin };
  return { label: 'uncertain', top1, margin };
}

/** 把二级判定折成动作。uncertain 默认 reject（保守）。 */
export function actionFor(label, { uncertainPolicy = 'reject' } = {}) {
  switch (label) {
    case 'direct':
    case 'command':
    case 'relevant_ambient':
      return 'wake';
    case 'irrelevant_ambient':
    case 'noise':
      return 'reject';
    case 'uncertain':
      return uncertainPolicy === 'wake' ? 'wake' : 'reject';
    default:
      return 'reject';
  }
}

/** 伪代码级预算判定：超限直接跳过并标注原因，与正常判定分开统计。 */
export function budgetGate({ spent, budget, circuitOpen = false }) {
  if (circuitOpen) return { skip: true, reason: 'circuit_open_skipped' };
  if (spent >= budget) return { skip: true, reason: 'budget_skipped' };
  return { skip: false };
}
