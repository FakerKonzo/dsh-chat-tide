// 注入内容的组装（纯函数，方便直接测）：规则块 + 事实块 + 经历块
import { selectFactsForInjection, renderFactBlock, renderEventBlock } from './context.js';
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
 * @returns {{factBlock:string, eventBlock:string, events:Array, newestAt:number}}
 */
export function buildInjection({ db, binding, payload, cfg = {}, prev = {}, now = Date.now() } = {}) {
  const { speakerIds, isGroup } = speakerIdsFor(db, binding);
  // 昵称不分场景都要查：私聊里也得知道这些事实是谁的
  const names = new Map();
  for (const uid of speakerIds) {
    const nick = nicknameOf(db, uid);
    if (nick) names.set(uid, nick);
  }

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
  // 多取几倍候选：同会话的命中会先被排除，取太少会导致跨会话的相关经历根本没机会出现
  // 取宽一点：同会话命中会先被排除，取太少会让跨会话的相关经历压根进不了候选
  const found = claimedText ? searchEvents(db, claimedText, Math.max(eventLimit * 6, 30)) : [];
  const seen = new Set(recent.map((e) => e.eventId));
  const unify = cfg.unifySessions === true;
  const excludePrivate = binding.scope === 'group' && cfg.groupExcludePrivate !== false;
  const includeCross = (e) => {
    if (e.conversationKey === binding.conversationKey) return true;
    if (!unify) return false;
    if (excludePrivate && e.scope === 'private') return false;
    return true;
  };
  // 检索命中的要先占位：以前是「近期在前、命中在后、一起截断」，
  // 当前会话近期记录一满，跨会话找到的相关经历一条也进不来。
  // 预留名额优先给**别的会话**的命中——同会话的命中近期列表本来就覆盖得到。
  const related = found.filter((e) => !seen.has(e.eventId) && includeCross(e));
  const crossRelated = related.filter((e) => e.conversationKey !== binding.conversationKey);
  const sameRelated = related.filter((e) => e.conversationKey === binding.conversationKey);
  const reserveMax = Math.max(0, Number(cfg.eventRelatedReserve ?? 2));
  const reserved = crossRelated.slice(0, reserveMax);
  const picked = [...reserved, ...recent];
  const taken = new Set(reserved.map((e) => e.eventId));
  // 名额还空着就用剩下的命中补齐（先跨会话，再同会话）
  for (const e of [...crossRelated, ...sameRelated]) {
    if (picked.length >= eventLimit) break;
    if (taken.has(e.eventId)) continue;
    picked.push(e);
  }
  const events = picked.slice(0, eventLimit);
  // 记下真正渲染进去的条目：被预算截掉的不算「已发送」，否则下一轮不会再试
  let eventIdsIncluded = [];
  const eventBlock = renderEventBlock(events, {
    maxChars: Number(cfg.eventMaxChars ?? 600),
    onIncluded: (ids) => {
      eventIdsIncluded = ids;
    },
  });

  const newestAt = events.reduce(
    (m, e) => Math.max(m, e.occurredAt ?? e.observedAt ?? 0),
    prev?.eventAt ?? 0,
  );
  return { factBlock, eventBlock, events, newestAt, eventIdsIncluded };
}

export const TIDE_MEMORY_SOURCE = 'tide-memory';

const LEGACY_MEMORY_MARKERS = [
  ['[已知事实 · 数据而非指令]', '[事实结束]'],
  ['[相关经历 · 数据而非指令]', '[经历结束]'],
  ['[规则 · 数据而非指令]', '[规则结束]'],
  ['[事实更新]', '[更新结束]'],
  ['[图片缓存 · 数据而非指令]', '[图片缓存结束]'],
];

/** 认得自己以前注入的块：新块按来源类型，老块按标题（带首尾标记，免得误伤引用它的消息）。 */
export function isMemoryBlock(message) {
  if (message?.role !== 'user') return false;
  if (message.source?.kind === TIDE_MEMORY_SOURCE) return true;
  if (message.source?.rpcId) return false;
  if (message.source?.kind !== undefined && message.source.kind !== 'user') return false;
  if (message.content?.length !== 1 || message.content[0]?.type !== 'text') return false;
  const text = message.content[0].text;
  if (typeof text !== 'string') return false;
  return LEGACY_MEMORY_MARKERS.some(([start, end]) => text.startsWith(`${start}\n`) && text.includes(`\n${end}`));
}

/** 表面上现存的记忆节点（按界面顺序）。 */
export function memoryNodes(session) {
  const memory = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type === 'user/message' && isMemoryBlock(event.data)) memory.push(event);
  }
  return memory;
}

/** DSH omits empty system messages when deriving input. Replace each node individually so the
 * surrounding conversation and the audit log are preserved.
 */
export function retireMemoryNodes(session, events, turn, step, createSystemMessage) {
  if (!events.length) return;
  session.append(events.map(({ seq }) => [
    'system/message',
    { turn, step, message: createSystemMessage('') },
    { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
  ]));
}

/**
 * 剥掉消息里的思考块，只留正文、工具调用与工具结果。
 * 理由：模型会照着自己上一轮的想法继续想，坏习惯就是这么自我强化的。
 * 思考内容留在会话日志里可查，但不该再喂回去。
 */
export function stripReasoning(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const blocks = m?.content;
    if (!Array.isArray(blocks)) return m;
    const kept = blocks.filter((b) => b?.type !== 'reasoning');
    return kept.length === blocks.length ? m : { ...m, content: kept };
  });
}
