import { unindexEvent } from './fts.js';
// 巡检：超时待确认、久拖冲突、积压向量。只报告不静默改数据（改前写审计）。
const DAY = 86_400_000;

export async function backfillVectors(db, { embedder, putVector, knn, table, limit = 50 } = {}) {
  const out = { attempted: 0, done: 0, failed: 0 };
  if (!embedder?.embed) return out;
  const hasVec = !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_fact'").get();
  const missing = hasVec
    ? 'fv.embedding_pending = 1 OR NOT EXISTS (SELECT 1 FROM vec_fact vv WHERE vv.rowid = fv.rowid)'
    : 'fv.embedding_pending = 1';
  const rows = db
    .prepare(
      `SELECT fv.fact_id AS factId, fv.version, fv.value FROM fact_version fv
         JOIN fact f ON f.fact_id = fv.fact_id AND f.current_version = fv.version
        WHERE f.status = 'active' AND (${missing})
        LIMIT ?`,
    )
    .all(limit);
  for (const row of rows) {
    out.attempted += 1;
    try {
      const [vec] = await embedder.embed([row.value]);
      const rid = db.prepare('SELECT rowid FROM fact_version WHERE fact_id=? AND version=?').get(row.factId, row.version).rowid;
      putVector(db, table, rid, vec);
      db.prepare('UPDATE fact_version SET embedding_pending = 0 WHERE fact_id=? AND version=?').run(row.factId, row.version);
      out.done += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

export function runJanitor(db, { now = Date.now(), pendingTtlMs = 7 * DAY, conflictTtlMs = 14 * DAY, limit = 200, rawLogDays = 0 } = {}) {
  const report = { expiredPending: [], staleConflicts: [], embeddingBacklog: [], actions: [] };

  // 1) 待确认超时 → superseded
  const stale = db
    .prepare(
      `SELECT fact_id AS factId FROM fact
        WHERE status = 'pending_confirmation' AND updated_at < ?
        LIMIT ?`,
    )
    .all(now - pendingTtlMs, limit);
  for (const row of stale) {
    db.prepare(`UPDATE fact SET status='superseded', updated_at=? WHERE fact_id=? AND status='pending_confirmation'`).run(now, row.factId);
    db.prepare(`UPDATE fact_version SET status='superseded' WHERE fact_id=?`).run(row.factId);
    report.expiredPending.push(row.factId);
  }

  // 2) 久未解决冲突 → 只报告（接口留给上层决定策略）
  report.staleConflicts = db
    .prepare(
      `SELECT conflict_id AS conflictId, fact_a AS factA, fact_b AS factB, created_at AS createdAt
         FROM fact_conflict WHERE resolved = 0 AND created_at < ? LIMIT ?`,
    )
    .all(now - conflictTtlMs, limit);

  // 3) 向量积压
  report.embeddingBacklog = db
    .prepare(
      `SELECT fact_id AS factId, version FROM fact_version
        WHERE embedding_pending = 1 LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({ kind: 'fact', factId: r.factId, version: r.version }));

  // 4) 历史垃圾观察（运行时元信息被误抽成经历）→ 标记 redacted 并解除索引
  const junk = db
    .prepare(
      `SELECT event_id AS eventId FROM event
        WHERE status = 'active' AND event_type IN ('observation','conversation')
          AND (content LIKE '%Current runtime context%' OR content LIKE '%Time sampled while preparing%'
               OR content LIKE '%system-reminder%' OR content LIKE '%The working directory changed%')
        LIMIT ?`,
    )
    .all(limit);
  for (const r of junk) {
    db.prepare(`UPDATE event SET status = 'redacted' WHERE event_id = ?`).run(r.eventId);
    try { unindexEvent(db, r.eventId); } catch { /* 无索引则跳过 */ }
  }
  report.junkEvents = junk.map((r) => r.eventId);

  // 5) 内容载荷保留期：过期只脱敏内容，保留审计信封（设计 §13.1）
  report.retentionRedacted = 0;
  if (rawLogDays > 0) {
    const cutoff = now - rawLogDays * DAY;
    const stale = db
      .prepare(
        `SELECT record_id AS recordId FROM raw_log
          WHERE payload_status = 'available' AND observed_at < ? LIMIT ?`,
      )
      .all(cutoff, limit);
    for (const r of stale) {
      db.prepare(`UPDATE raw_log SET payload = NULL, payload_status = 'redacted' WHERE record_id = ?`).run(r.recordId);
    }
    report.retentionRedacted = stale.length;
  }

  // 6) 孤儿向量：已删除/已覆盖的版本不该继续参与 KNN
  report.orphanVectors = { facts: 0, events: 0 };
  try {
    const factOrphans = db
      .prepare(
        `SELECT v.rowid AS rowid FROM vec_fact v
          WHERE NOT EXISTS (
            SELECT 1 FROM fact_version fv
              JOIN fact f ON f.fact_id = fv.fact_id AND f.current_version = fv.version
             WHERE fv.rowid = v.rowid AND f.status = 'active')
          LIMIT ?`,
      )
      .all(limit);
    for (const r of factOrphans) {
      db.prepare('DELETE FROM vec_fact WHERE rowid = ?').run(BigInt(r.rowid));
      report.orphanVectors.facts++;
    }
    const eventOrphans = db
      .prepare(`SELECT v.rowid AS rowid FROM vec_event v WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.rowid = v.rowid AND e.status = 'active') LIMIT ?`)
      .all(limit);
    for (const r of eventOrphans) {
      db.prepare('DELETE FROM vec_event WHERE rowid = ?').run(BigInt(r.rowid));
      report.orphanVectors.events++;
    }
  } catch {
    /* 向量表不存在则跳过 */
  }

  report.actions = [
    ...report.expiredPending.map((factId) => ({ kind: 'expire-pending', factId })),
    ...report.embeddingBacklog.map((x) => ({ kind: 'reembed', ...x })),
    ...(report.junkEvents ?? []).map((eventId) => ({ kind: 'redact-event', eventId })),
    ...(report.orphanVectors.facts + report.orphanVectors.events > 0 ? [{ kind: 'prune-vectors', ...report.orphanVectors }] : []),
    ...(report.retentionRedacted > 0 ? [{ kind: 'redact-payload', count: report.retentionRedacted }] : []),
  ];
  return report;
}
