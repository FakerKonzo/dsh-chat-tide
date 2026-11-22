// 补偿抽取：对“有原始消息但没有抽取审计”的轮次补跑一次，避免掉线/改配置期间的记忆缺口。
import { appendEvent } from './events.js';
import { writeFact } from './facts.js';
import { extractItems } from './extract.js';
import { conversationScope } from './scope.js';
import { looksMemorable } from './prefilter.js';

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

/** 找出漏抽的轮次（按 correlation_id 分组，且没有 memory_extract 审计）。 */
export function findMissedExtractions(db, { sinceMs = DEFAULT_SINCE_MS, limit = 10, now = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT r.correlation_id AS correlationId, r.conversation_key AS conversationKey,
              MAX(r.observed_at) AS lastAt, COUNT(*) AS n
         FROM raw_log r
        WHERE r.record_type = 'message'
          AND r.correlation_id IS NOT NULL
          AND r.observed_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM event e
             WHERE e.event_type = 'memory_extract' AND e.correlation_id = r.correlation_id
          )
        GROUP BY r.correlation_id
        ORDER BY lastAt DESC
        LIMIT ?`,
    )
    .all(now - sinceMs, limit);
  return rows.map((r) => {
    const texts = db
      .prepare(
        `SELECT payload, user_id AS userId, record_id AS recordId, metadata
           FROM raw_log WHERE correlation_id = ? ORDER BY observed_at`,
      )
      .all(r.correlationId);
    return {
      ...r,
      text: texts.map((t) => t.payload).join('\n').slice(0, 3000),
      userId: texts[texts.length - 1]?.userId ?? null,
      recordId: texts[texts.length - 1]?.recordId ?? null,
      // 补偿抽取也带上说话人；身份未知时按「非主人」保守处理，不能凭空定规矩
      speakerName: (() => {
        try {
          return JSON.parse(texts[texts.length - 1]?.metadata ?? '{}')?.senderName ?? null;
        } catch {
          return null;
        }
      })(),
    };
  });
}

/**
 * 补跑抽取。返回 {attempted, facts, events}。
 * 新写入的事实统一标 embedding_pending=1，交给向量补算处理。
 */
export async function runRepairExtractions(db, { complete, limit = 10, sinceMs = DEFAULT_SINCE_MS, now = Date.now(), log } = {}) {
  const out = { attempted: 0, facts: 0, events: 0 };
  const missed = findMissedExtractions(db, { limit, sinceMs, now });
  for (const m of missed) {
    if (!looksMemorable(m.text, { minChars: 4 })) {
      // 不值得抽的也记一条审计，避免每次都重试
      appendEvent(db, {
        eventId: `evt-extract-skip-${m.correlationId}-${now}`,
        eventType: 'memory_extract',
        content: JSON.stringify({ skipped: true, chars: m.text.length }),
        conversationKey: m.conversationKey,
        correlationId: m.correlationId,
        occurredAt: now,
      });
      continue;
    }
    out.attempted += 1;
    const items = await extractItems({
      complete,
      text: m.text,
      userId: m.userId ?? m.conversationKey,
      subjectId: m.userId ?? m.conversationKey,
      assertedBy: m.userId ?? null,
      sourceRecordId: m.recordId,
      scope: conversationScope(m.conversationKey),
      // 补偿抽取以前不带身份，规则准入就把它当成「未知」放行；这里补上
      speakerName: m.speakerName ?? null,
      isOwner: m.isOwner === true,
      now,
    });
    for (const [i, ev] of items.events.entries()) {
      const eventId = `evt-obs-repair-${m.correlationId}-${i}`;
      try {
        appendEvent(db, {
          eventId,
          eventType: 'observation',
          content: ev.content,
          userId: ev.userId ?? m.userId,
          conversationKey: m.conversationKey,
          occurredAt: ev.occurredAt ?? now,
          correlationId: m.correlationId,
          sourceRecordId: m.recordId,
        });
        out.events += 1;
      } catch (err) {
        log?.('warn', 'repair-event', { error: String(err?.message ?? err) });
      }
    }
    for (const cand of items.facts) {
      try {
        const res = writeFact(db, cand);
        if (res.versionRowid) {
          try {
            db.prepare('UPDATE fact_version SET embedding_pending = 1 WHERE fact_id=? AND version=?').run(res.factId, res.version);
          } catch {
            /* ignore */
          }
        }
        out.facts += 1;
      } catch (err) {
        log?.('warn', 'repair-fact', { error: String(err?.message ?? err) });
      }
    }
    appendEvent(db, {
      eventId: `evt-extract-repair-${m.correlationId}-${now}`,
      eventType: 'memory_extract',
      content: JSON.stringify({ repair: true, chars: m.text.length, facts: items.facts.length, events: items.events.length }),
      conversationKey: m.conversationKey,
      correlationId: m.correlationId,
      occurredAt: now,
    });
  }
  return out;
}
