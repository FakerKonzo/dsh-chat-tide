// 补偿抽取：对“有原始消息但没有抽取审计”的轮次补跑一次，避免掉线/改配置期间的记忆缺口。
import { appendEvent } from './events.js';
import { writeFact } from './facts.js';
import { extractItems } from './extract.js';
import { conversationScope } from './scope.js';
import { isInjectedBlock, looksMemorable, stripHostNoise } from './prefilter.js';

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
    const messages = db
      .prepare(
        `SELECT payload, user_id AS userId, record_id AS recordId, metadata
           FROM raw_log WHERE correlation_id = ? AND record_type = 'message'
           ORDER BY observed_at, rowid`,
      )
      .all(r.correlationId)
      .filter((message) => message.payload && !isInjectedBlock(message.payload));
    return { ...r, messages };
  });
}

function repairInput(m, ownerIds) {
  const lines = [];
  const speakers = [];
  const multi = m.messages.length > 1;
  let remaining = 3000;
  for (const message of m.messages) {
    let name = null;
    try {
      name = JSON.parse(message.metadata ?? '{}')?.senderName ?? null;
    } catch {
      /* 旧记录可以缺少元数据，记录 ID 仍能确定来源。 */
    }
    const label = `消息${speakers.length + 1}`;
    const prefix = multi ? `[${label}]${name ? ` ${name}` : ''} ` : '';
    if (remaining <= prefix.length) break;
    const clean = stripHostNoise(message.payload);
    if (!clean) continue;
    const sourceText = clean.slice(0, remaining - prefix.length);
    const line = prefix + sourceText;
    lines.push(line);
    remaining -= line.length + 1;
    speakers.push({
      label,
      sourceText,
      name,
      userId: message.userId ?? m.conversationKey,
      recordId: message.recordId,
      isOwner: ownerIds.has(message.userId),
    });
  }
  const speaker = speakers[0];
  return {
    text: lines.join('\n'),
    userId: speaker?.userId ?? m.conversationKey,
    assertedBy: speaker?.userId ?? null,
    sourceRecordId: speaker?.recordId ?? null,
    speakerName: speaker?.name ?? null,
    isOwner: speaker?.isOwner ?? false,
    speakers,
  };
}

/**
 * 补跑抽取。返回 {attempted, facts, events}。
 * 新写入的事实统一标 embedding_pending=1，交给向量补算处理。
 */
export async function runRepairExtractions(db, { complete, getExtractSettings = () => ({}), ownerIds = new Set(), limit = 10, sinceMs = DEFAULT_SINCE_MS, now = Date.now(), log } = {}) {
  const out = { attempted: 0, facts: 0, events: 0 };
  const missed = findMissedExtractions(db, { limit, sinceMs, now });
  for (const m of missed) {
    if (getExtractSettings().enabled === false) break;
    const input = repairInput(m, ownerIds);
    if (!looksMemorable(input.text, { minChars: 4 })) {
      // 不值得抽的也记一条审计，避免每次都重试
      appendEvent(db, {
        eventId: `evt-extract-skip-${m.correlationId}-${now}`,
        eventType: 'memory_extract',
        content: JSON.stringify({ skipped: true, chars: input.text.length }),
        conversationKey: m.conversationKey,
        correlationId: m.correlationId,
        occurredAt: now,
      });
      continue;
    }
    out.attempted += 1;
    const scope = conversationScope(m.conversationKey);
    const items = await extractItems({ ...input, complete, scope, now });
    const settings = getExtractSettings();
    if (settings.enabled === false) break;
    const before = { ...out };
    for (const [i, ev] of (settings.storeEvents === false ? [] : items.events).entries()) {
      const eventId = `evt-obs-repair-${m.correlationId}-${i}`;
      try {
        appendEvent(db, {
          eventId,
          eventType: 'observation',
          content: ev.content,
          userId: ev.userId,
          speakerName: ev.speakerName,
          scope,
          conversationKey: m.conversationKey,
          occurredAt: ev.occurredAt ?? now,
          correlationId: m.correlationId,
          sourceRecordId: ev.sourceRecordId,
        });
        out.events += 1;
      } catch (err) {
        log?.('warn', 'repair-event', { error: String(err?.message ?? err) });
      }
    }
    for (const cand of (settings.storeFacts === false ? [] : items.facts)) {
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
      content: JSON.stringify({ repair: true, chars: input.text.length, facts: out.facts - before.facts, events: out.events - before.events }),
      conversationKey: m.conversationKey,
      correlationId: m.correlationId,
      occurredAt: now,
    });
  }
  return out;
}
