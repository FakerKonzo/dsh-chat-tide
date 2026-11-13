// 路由决策：把 ambient 判定链收成一个可单测的函数（不含日志/事件写入）
import { classify, decideAmbient, actionFor } from './route.js';
import { activePolicies, activeSilence, applyPolicies } from './silence.js';
import { consumeBudget } from './budget.js';
import { shouldReplyToAmbient } from './ambient.js';
import { classifyByLlm } from './llmroute.js';
import { knn, distanceToCosine } from './vec.js';
import { searchEvents, searchFacts, bigram } from './fts.js';
import { matchAttention, bumpAttentionHit } from './attention.js';

/**
 * @returns {{action:'wake'|'reject', label:string, reason:string, detail:object}}
 */
function parseHm(text, fallbackMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return fallbackMinutes;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 是否处于静默时段（本地时间，支持跨零点）。 */
export function inQuietHours(now, { quietEnabled, quietStart = '00:00', quietEnd = '08:00' } = {}) {
  if (!quietEnabled) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = parseHm(quietStart, 0);
  const end = parseHm(quietEnd, 480);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 今天已主动接茬次数与最近一次时间（以审计事件为准）。 */
export function wakeStats(db, now = Date.now(), conversationKey = null) {
  try {
    const base =
      "SELECT occurred_at AS at FROM event WHERE event_type='route_decision' AND (content LIKE '%attention-hit%' OR content LIKE '%ambient-explore%') AND occurred_at >= ?";
    const rows = conversationKey
      ? db.prepare(base + ' AND conversation_key = ?').all(startOfLocalDay(now), conversationKey)
      : db.prepare(base).all(startOfLocalDay(now));
    const times = rows.map((r) => Number(r.at ?? 0)).filter(Boolean);
    return { count: times.length, lastAt: times.length ? Math.max(...times) : 0 };
  } catch {
    return { count: 0, lastAt: 0 };
  }
}

export async function decideRoute({
  db,
  cfg,
  binding,
  text,
  isMentioned = false,
  embedder = null,
  vecReady = false,
  circuitOpen = false,
  complete = null,
  random = Math.random,
  now = Date.now(),
}) {
  // 私聊不过滤：一对一对话一律放行
  if (binding.scope === 'c2c') {
    return { action: 'wake', label: 'direct', reason: 'private-chat', detail: { label0: 'direct' } };
  }
  const label0 = classify({ text, isMentioned });
  const detail = { label0, top1: 0, top2: 0, margin: 0, factTop1: 0 };

  // 1) 临时策略 / 禁言
  const policies = activePolicies(db, binding.conversationKey, now);
  if (applyPolicies(policies, label0) === 'drop') return { action: 'reject', label: label0, reason: 'policy-drop', detail };
  if (label0 === 'ambient' && activeSilence(db, { scopeId: binding.peerId }, now)) {
    return { action: 'reject', label: label0, reason: 'silenced', detail };
  }

  // 2) direct / command 直接放行
  if (label0 !== 'ambient') return { action: 'wake', label: label0, reason: 'direct-or-command', detail };

  // 3) 预算
  const budget = consumeBudget(db, binding.conversationKey, { budget: cfg.routing.budget ?? 1000, now });
  if (!budget.allowed) return { action: 'reject', label: 'uncertain', reason: 'budget_skipped', detail };

  // 4) 熔断
  if (circuitOpen) return { action: 'reject', label: 'uncertain', reason: 'circuit_open_skipped', detail };

  // 5) 向量判定（事件 + 事实）
  let verdict = { label: 'uncertain', top1: 0, top2: 0, factTop1: 0 };
  if (embedder && vecReady) {
    try {
      const [qvec] = await embedder.embed([text]);
      const nearEvents = knn(db, 'vec_event', qvec, 2);
      const nearFacts = knn(db, 'vec_fact', qvec, 2);
      const sims = [...nearEvents, ...nearFacts].map((r) => distanceToCosine(r.distance)).sort((a, b) => b - a);
      const top1 = sims[0] ?? 0;
      const top2 = sims[1] ?? 0;
      const factTop1 = nearFacts[0] ? distanceToCosine(nearFacts[0].distance) : 0;
      let topFactId = null;
      if (nearFacts[0]) {
        try {
          topFactId = db.prepare('SELECT fact_id AS fid FROM fact_version WHERE rowid = ?').get(nearFacts[0].rowid)?.fid ?? null;
        } catch {
          topFactId = null;
        }
      }
      verdict = {
        ...decideAmbient({ top1, top2, high: cfg.routing.high, low: cfg.routing.low, marginThreshold: cfg.routing.margin }),
        top1,
        top2,
        factTop1,
        factId: topFactId,
        qvec,
      };
    } catch {
      detail.embedError = true;
    }
  }
  Object.assign(detail, { top1: verdict.top1, top2: verdict.top2, margin: (verdict.top1 ?? 0) - (verdict.top2 ?? 0), factTop1: verdict.factTop1 ?? 0 });

  // 5.5) FTS 救援：灰区里如果关键词能命中记忆，判为相关（零 token）
  if (cfg.routing.ftsRescue !== false && verdict.label === 'uncertain' && text) {
    try {
      const grams = [...new Set(bigram(text).split(' ').filter((g) => g.length >= 2))];
      const factHits = searchFacts(db, text, 5)
        .map((h) => {
          try {
            const row = db
              .prepare('SELECT v.surface, v.value, f.subtype FROM fact_version v JOIN fact f ON f.fact_id = v.fact_id WHERE f.fact_id = ? AND f.current_version = v.version')
              .get(String(h.factId));
            if (!row || row.subtype === 'rule') return null;
            return row.surface ?? row.value;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const found = [...searchEvents(db, text, 5).map((h) => h.content), ...factHits];
      let bestOverlap = 0;
      for (const content of found) {
        if (!content) continue;
        const c = String(content);
        const hitCount = grams.filter((g) => c.includes(g)).length;
        const ratio = grams.length ? hitCount / grams.length : 0;
        if (hitCount >= 2 && ratio >= 0.2) bestOverlap = Math.max(bestOverlap, ratio);
      }
      if (bestOverlap > 0) {
        verdict = { ...verdict, label: 'relevant_ambient', via: 'fts', ftsOverlap: bestOverlap };
        detail.ftsOverlap = bestOverlap;
      }
    } catch {
      /* FTS 不可用则忽略 */
    }
  }

  // 6) 示例库
  if (verdict.label === 'uncertain' && verdict.qvec && vecReady) {
    try {
      const near = knn(db, 'vec_exemplar', verdict.qvec, 3);
      const ids = near.map((r) => Number(r.rowid));
      if (ids.length) {
        const rowsEx = db
          .prepare(`SELECT rowid, label FROM exemplar WHERE approved = 1 AND rowid IN (${ids.map(() => '?').join(',')})`)
          .all(...ids);
        const byRowid = new Map(rowsEx.map((r) => [Number(r.rowid), r.label]));
        for (const n of near) {
          const lab = byRowid.get(Number(n.rowid));
          const score = distanceToCosine(n.distance);
          if (lab && score >= (cfg.routing.exemplarThreshold ?? 0.5)) {
            verdict = { ...verdict, label: lab, via: 'exemplar' };
            break;
          }
        }
      }
    } catch {
      /* 示例库失败忽略 */
    }
  }

  // 7) LLM 兜底
  if (verdict.label === 'uncertain' && cfg.routing.llmFallback && complete) {
    const recent = db
      .prepare('SELECT payload FROM raw_log WHERE conversation_key = ? ORDER BY observed_at DESC LIMIT 5')
      .all(binding.conversationKey)
      .map((r) => r.payload)
      .reverse()
      .join('\n');
    const lab = await classifyByLlm({ complete, text, context: recent });
    verdict = { ...verdict, label: lab, via: 'llm' };
  }

  // 8) 只有 relevant 才继续
  detail.verdict = verdict.label;
  if (verdict.label === 'irrelevant_ambient') {
    return { action: 'reject', label: verdict.label, reason: 'irrelevant-ambient', detail };
  }
  if (verdict.label !== 'relevant_ambient') {
    return { action: 'reject', label: verdict.label, reason: 'uncertain-policy:' + (cfg.routing.uncertainPolicy ?? 'reject'), detail };
  }

  // 8.5) 关注点判定：关注点本身在向量空间里，命中就直接唤醒
  const attentionEnabled = cfg.attention?.enabled !== false;
  let attentionHit = null;
  if (attentionEnabled && vecReady && verdict.qvec) {
    try {
      const near = knn(db, 'vec_attention', verdict.qvec, 3);
      const ids = near.map((n) => Number(n.rowid));
      if (ids.length) {
        const rows = db
          .prepare(
            `SELECT rowid, attention_id AS id, label FROM attention
              WHERE status = 'active' AND rowid IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids);
        const byRowid = new Map(rows.map((r) => [Number(r.rowid), r]));
        const sims = near
          .map((n) => ({ row: byRowid.get(Number(n.rowid)), cos: distanceToCosine(n.distance) }))
          .filter((x) => x.row)
          .sort((a, b) => b.cos - a.cos);
        const high = Number(cfg.routing.attentionThreshold ?? 0.5);
        const soft = high - Number(cfg.routing.attentionSoftBand ?? 0.05);
        const marginNeed = Number(cfg.routing.attentionMargin ?? 0.04);
        if (sims.length) {
          const top = sims[0];
          const margin = sims.length > 1 ? top.cos - sims[1].cos : top.cos;
          const hit = top.cos >= high || (top.cos >= soft && margin >= marginNeed);
          if (hit) attentionHit = { id: top.row.id, label: top.row.label, score: top.cos, margin };
        }
      }
    } catch {
      /* 向量不可用时视为未命中，走探索 */
    }
  }
  // 事件/事实绑定的关注点：命中的东西本身就是我在意的
  if (!attentionHit && attentionEnabled && verdict.factId) {
    try {
      const row = db
        .prepare("SELECT attention_id AS id, label, weight FROM attention WHERE status = 'active' AND ref_id = ? ORDER BY weight DESC LIMIT 1")
        .get(verdict.factId);
      if (row) attentionHit = { id: row.id, label: row.label, score: null };
    } catch {
      /* ignore */
    }
  }

  // 8.6) 静默时段与每日上限（两种唤醒都受约束）
  if (inQuietHours(now, cfg.routing)) {
    return { action: 'reject', label: verdict.label, reason: 'quiet-hours', detail };
  }
  {
    const cap = Number(cfg.routing.maxWakesPerDay ?? 0);
    if (cap > 0 && wakeStats(db, now, binding.conversationKey).count >= cap) {
      return { action: 'reject', label: verdict.label, reason: 'daily-cap', detail };
    }
  }

  // 8.7) 关注点命中：直接唤醒，不再掷骰子
  if (attentionHit) {
    detail.attention = attentionHit.label;
    detail.attentionScore = attentionHit.score;
    try {
      bumpAttentionHit(db, attentionHit.id);
    } catch {
      /* ignore */
    }
    return { action: 'wake', label: verdict.label, reason: 'attention-hit', detail };
  }

  // 9) 探索：不在关注范围内，给个小概率看看，说不说由模型自己定
  const gapMin = Number(cfg.routing.minWakeIntervalMinutes ?? 0);
  if (gapMin > 0) {
    const last = wakeStats(db, now, binding.conversationKey).lastAt;
    if (last && now - last < gapMin * 60_000) {
      return { action: 'reject', label: verdict.label, reason: 'cooldown', detail };
    }
  }
  const forceUntil = cfg.routing.forceWakeUntil ?? 0;
  if (forceUntil > now) {
    detail.gate = 'forced';
    return { action: 'wake', label: verdict.label, reason: 'ambient-explore', detail };
  }
  const p = Number(cfg.routing.ambientReplyProbability ?? 0.1);
  if (p <= 0) return { action: 'reject', label: verdict.label, reason: 'explore-off', detail };
  const roll = random();
  detail.gate = 'explore';
  detail.roll = roll;
  if (roll >= p) return { action: 'reject', label: verdict.label, reason: 'explore-miss', detail };
  return { action: 'wake', label: verdict.label, reason: 'ambient-explore', detail };
}
