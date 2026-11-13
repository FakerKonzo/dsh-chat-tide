// 路由预算：按窗口累计花费，超限记 budget_skipped（与熔断分开）。
export const DEFAULT_WINDOW_MS = 5 * 60_000;

/** 读当前窗口已花费，不写入。 */
export function peekBudget(db, conversationKey, { windowMs = DEFAULT_WINDOW_MS, now = Date.now() } = {}) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = db
    .prepare('SELECT spent FROM route_budget WHERE conversation_key = ? AND window_start = ?')
    .get(conversationKey, windowStart);
  return { windowStart, spent: row?.spent ?? 0 };
}

/**
 * 尝试花掉一次预算。
 * @returns {{allowed:boolean, spent:number, remaining:number, windowStart:number}}
 */
export function consumeBudget(db, conversationKey, { windowMs = DEFAULT_WINDOW_MS, budget = 1000, cost = 1, now = Date.now() } = {}) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = db
    .prepare('SELECT spent FROM route_budget WHERE conversation_key = ? AND window_start = ?')
    .get(conversationKey, windowStart);
  const spent = row?.spent ?? 0;
  if (spent + cost > budget) return { allowed: false, spent, remaining: Math.max(0, budget - spent), windowStart };
  if (row) {
    db.prepare('UPDATE route_budget SET spent = spent + ? WHERE conversation_key = ? AND window_start = ?').run(cost, conversationKey, windowStart);
  } else {
    db.prepare('INSERT INTO route_budget(conversation_key, window_start, spent) VALUES (?,?,?)').run(conversationKey, windowStart, cost);
  }
  return { allowed: true, spent: spent + cost, remaining: Math.max(0, budget - spent - cost), windowStart };
}

/** 清理过期窗口（低频调用）。 */
export function pruneBudgets(db, { windowMs = DEFAULT_WINDOW_MS, now = Date.now(), keepWindows = 12 } = {}) {
  const cutoff = Math.floor(now / windowMs) * windowMs - keepWindows * windowMs;
  const res = db.prepare('DELETE FROM route_budget WHERE window_start < ?').run(cutoff);
  return { pruned: res.changes };
}
