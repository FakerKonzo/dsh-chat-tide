// 多跳合并：把 fact_get 的候选集按确定性规则合并，不把推测当事实。
const TIER_RANK = { human_explicit: 3, source_verifiable: 2, agent_inferred: 1 };

/**
 * 合并同一批候选：
 * - 只考虑 active / pending_confirmation（deleted 直接丢弃）
 * - 同键按 provenance_tier → occurredAt 仲裁，取一个主值
 * - 其余作为 alternatives 保留（附来源与状态）
 * @returns {{key:string, primary:object|null, alternatives:object[], conflicts:object[]}}
 */
export function mergeCandidates(rows) {
  const alive = (rows ?? []).filter((r) => r && r.status !== 'deleted');
  if (!alive.length) return { key: null, primary: null, alternatives: [], conflicts: [] };

  const key = alive[0].canonicalKey ?? null;
  const sorted = [...alive].sort((a, b) => {
    const ta = TIER_RANK[a.tier] ?? 0;
    const tb = TIER_RANK[b.tier] ?? 0;
    if (tb !== ta) return tb - ta;
    const oa = a.occurredAt ?? 0;
    const ob = b.occurredAt ?? 0;
    if (ob !== oa) return ob - oa;
    return (b.version ?? 0) - (a.version ?? 0);
  });

  const primary = sorted[0];
  const alternatives = sorted.slice(1);
  const activeCount = alive.filter((r) => r.status === 'active').length;
  const conflicts = activeCount > 1 ? alive.filter((r) => r.status === 'active') : [];
  return { key, primary, alternatives, conflicts };
}

/** 多键批量合并（多跳检索用）。 */
export function mergeByKey(groups) {
  const out = [];
  for (const [key, rows] of Object.entries(groups ?? {})) {
    out.push({ requestedKey: key, ...mergeCandidates(rows) });
  }
  return out;
}

/** 渲染成可注入的确定性文本（不含推测）。 */
export function renderMerged(merged, { maxChars = 800 } = {}) {
  const lines = [];
  let used = 0;
  for (const group of merged) {
    if (!group.primary) continue;
    const line = `- ${group.requestedKey}: ${group.primary.value}（${group.primary.tier}）`;
    if (used + line.length > maxChars && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? lines.join('\n') : '';
}
