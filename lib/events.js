// 事件与原始记录：入站镜像、判重、事件追加。
import { dedupeKey, contentHash, sniffPlatformMsgId } from './dedupe.js';
import { indexEvent, unindexEvent } from './fts.js';

/** 这些事件类型才进召回索引；route_decision / silence / memory_conflict 永不进。 */
export const INDEXED_EVENT_TYPES = new Set(['conversation', 'observation']);

export function appendRawLog(db, entry) {
  const key = entry.dedupeKey ?? dedupeKey({
    adapter: entry.adapter,
    peerId: entry.peerId,
    platformMsgId: entry.platformMsgId,
    text: entry.payload,
    observedAt: entry.observedAt,
  });
  try {
    db.prepare(
      `INSERT INTO raw_log(record_id,record_type,adapter,peer_id,user_id,conversation_key,platform,
                           correlation_id,causation_id,content_hash,dedupe_key,observed_at,payload,payload_status,metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entry.recordId,
      entry.recordType,
      entry.adapter ?? null,
      entry.peerId ?? null,
      entry.userId ?? null,
      entry.conversationKey ?? null,
      entry.platform ?? null,
      entry.correlationId ?? null,
      entry.causationId ?? null,
      contentHash(entry.payload ?? ''),
      key,
      entry.observedAt,
      entry.payload ?? null,
      entry.payloadStatus ?? 'available',
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
    return { inserted: true, dedupeKey: key };
  } catch (err) {
    if (/UNIQUE/.test(String(err?.message))) return { inserted: false, dedupeKey: key };
    throw err;
  }
}

export function appendEvent(db, ev) {
  db.prepare(
    `INSERT INTO event(event_id,user_id,conversation_key,event_type,content,occurred_at,observed_at,
                       correlation_id,causation_id,source_record_id,status,indexed,speaker_name,scope)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ev.eventId,
    ev.userId ?? null,
    ev.conversationKey ?? null,
    ev.eventType,
    ev.content ?? null,
    ev.occurredAt ?? null,
    ev.observedAt ?? Date.now(),
    ev.correlationId ?? null,
    ev.causationId ?? null,
    ev.sourceRecordId ?? null,
    ev.status ?? 'active',
    INDEXED_EVENT_TYPES.has(ev.eventType) ? 1 : 0,
    ev.speakerName ?? null,
    ev.scope ?? null,
  );
  if (INDEXED_EVENT_TYPES.has(ev.eventType) && ev.content) indexEvent(db, ev.eventId, ev.content);
  return ev.eventId;
}

export function deleteEvent(db, eventId, { reason = 'manual' } = {}) {
  unindexEvent(db, eventId);
  try {
    const row = db.prepare('SELECT rowid FROM event WHERE event_id = ?').get(eventId);
    if (row) db.prepare('DELETE FROM vec_event WHERE rowid = ?').run(BigInt(row.rowid));
  } catch {
    /* 向量表不存在则跳过 */
  }
  db.prepare(`UPDATE event SET status='deleted', content=NULL WHERE event_id=?`).run(eventId);
  db.prepare('INSERT INTO tombstone(target_type, target_id, created_at, reason) VALUES (?,?,?,?)').run('event', eventId, Date.now(), reason);
}

export { sniffPlatformMsgId };
