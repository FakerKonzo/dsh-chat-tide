// 注入内容的组装（纯函数，方便直接测）：规则块 + 事实块 + 经历块
import {
  selectRuleFacts,
  ruleScopeOf,
  selectFactsForInjection,
  renderRuleBlock,
  renderFactBlock,
  renderEventBlock,
} from './context.js';
import { searchEvents } from './fts.js';
import { nicknameOf } from './people.js';

/** 群聊按最近发过言的人取事实；私聊取最近发言人。 */
export function speakerIdsFor(db, binding) {
  const latestSender = db
    .prepare(
      `SELECT user_id AS uid FROM raw_log WHERE conversation_key = ? AND user_id IS NOT NULL ORDER BY observed_at DESC LIMIT 1`,
    )
    .get(binding.conversationKey);
  const ids = [binding.peerId, latestSender?.uid].filter(Boolean);
  if (binding.scope !== 'group') return { speakerIds: ids, isGroup: false };
  try {
    const recent = db
      .prepare(
        `SELECT DISTINCT user_id AS uid FROM raw_log
          WHERE conversation_key = ? AND user_id IS NOT NULL
          ORDER BY observed_at DESC LIMIT 8`,
      )
      .all(binding.conversationKey)
      .map((r) => r.uid);
    return { speakerIds: [...new Set([...recent, latestSender?.uid].filter(Boolean))], isGroup: true };
  } catch {
    return { speakerIds: ids, isGroup: true };
  }
}

/**
 * 组装这一轮的注入块。
 * @returns {{ruleBlock:string, factBlock:string, eventBlock:string, events:Array, newestAt:number}}
 */
export function buildInjection({ db, binding, payload, cfg = {}, prev = {}, now = Date.now() } = {}) {
  const { speakerIds, isGroup } = speakerIdsFor(db, binding);
  // 昵称不分场景都要查：私聊里也得知道这些事实是谁的
  const names = new Map();
  for (const uid of speakerIds) {
    const nick = nicknameOf(db, uid);
    if (nick) names.set(uid, nick);
  }

  let ruleDropped = 0;
  const scope = ruleScopeOf(binding);
  const ruleBlock = renderRuleBlock(selectRuleFacts(db, { scope }), {
    maxChars: cfg.ruleMaxChars ?? 5000,
    onTruncate: (n) => {
      ruleDropped = n;
    },
  });
  const factBlock = renderFactBlock(
    selectFactsForInjection(db, { isGroup, speakerIds, cfg }),
    { maxChars: cfg.maxChars, withSpeaker: true, names },
  );

  const claimedText = (payload?.messages ?? [])
    .map((m) => (m?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(' '))
    .join(' ')
    .slice(0, 300);
  const recentDays = Number(cfg.recentDays ?? 7);
  const eventLimit = Number(cfg.eventLimit ?? 5);
  const recent = db
    .prepare(
      `SELECT event_id AS eventId, event_type AS eventType, content, speaker_name AS speakerName,
              occurred_at AS occurredAt, scope
         FROM event
        WHERE conversation_key = ? AND status = 'active'
          AND event_type IN ('observation', 'conversation')
          AND occurred_at > ?
        ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(binding.conversationKey, now - recentDays * 86_400_000, eventLimit);
  const found = claimedText ? searchEvents(db, claimedText, eventLimit) : [];
  const seen = new Set(recent.map((e) => e.eventId));
  const unify = cfg.unifySessions === true;
  const excludePrivate = binding.scope === 'group' && cfg.groupExcludePrivate !== false;
  const includeCross = (e) => {
    if (e.conversationKey === binding.conversationKey) return true;
    if (!unify) return false;
    if (excludePrivate && e.scope === 'private') return false;
    return true;
  };
  const events = [...recent, ...found.filter((e) => !seen.has(e.eventId) && includeCross(e))].slice(0, eventLimit);
  const eventBlock = renderEventBlock(events, { maxChars: Number(cfg.eventMaxChars ?? 600) });

  const newestAt = events.reduce(
    (m, e) => Math.max(m, e.occurredAt ?? e.observedAt ?? 0),
    prev?.eventAt ?? 0,
  );
  return { ruleBlock, factBlock, eventBlock, events, newestAt, ruleDropped };
}

/**
 * 增量：规则/事实只在变化时给；经历按 id 去重。
 * 旧实现比时间戳，检索命中的历史经历永远比上次时间戳旧，送不出去。
 */
export function diffInjection({ built, prev = {}, cfg = {} }) {
  const ruleDelta = built.ruleBlock && built.ruleBlock !== prev.ruleBlock ? built.ruleBlock : '';
  const factDelta = built.factBlock && built.factBlock !== prev.factBlock ? built.factBlock : '';
  const sent = new Set(prev.eventIds ?? []);
  const fresh = built.events.filter((e) => !sent.has(e.eventId));
  const eventDelta = fresh.length ? renderEventBlock(fresh, { maxChars: Number(cfg.eventMaxChars ?? 600) }) : '';
  const eventIds = [...new Set([...(prev.eventIds ?? []), ...built.events.map((e) => e.eventId)])].slice(-50);
  return { ruleDelta, factDelta, eventDelta, eventIds };
}
