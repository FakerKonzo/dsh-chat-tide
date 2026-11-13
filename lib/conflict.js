// 冲突整理：把未解决冲突按人工/整理策略落定，全部写审计。
export function resolveConflict(db, conflictId, { keep, by = 'janitor', now = Date.now() } = {}) {
  const conf = db.prepare('SELECT * FROM fact_conflict WHERE conflict_id = ?').get(conflictId);
  if (!conf) return { ok: false, reason: 'not-found' };
  if (conf.resolved) return { ok: false, reason: 'already-resolved' };

  const a = db.prepare('SELECT fact_id, status FROM fact WHERE fact_id = ?').get(conf.fact_a);
  const b = db.prepare('SELECT fact_id, status FROM fact WHERE fact_id = ?').get(conf.fact_b);
  if (!a || !b) return { ok: false, reason: 'missing-fact' };

  db.exec('BEGIN IMMEDIATE');
  try {
    const pick = keep === 'b' ? b : a;
    const drop = keep === 'b' ? a : b;
    if (drop.status === 'pending_confirmation') {
      db.prepare(`UPDATE fact SET status='superseded', updated_at=? WHERE fact_id=?`).run(now, drop.fact_id);
      db.prepare(`UPDATE fact_version SET status='superseded' WHERE fact_id=?`).run(drop.fact_id);
    }
    if (pick.status === 'pending_confirmation') {
      db.prepare(`UPDATE fact SET status='active', updated_at=? WHERE fact_id=?`).run(now, pick.fact_id);
      db.prepare(`UPDATE fact_version SET status='active' WHERE fact_id=? AND version=(SELECT current_version FROM fact WHERE fact_id=?)`).run(pick.fact_id, pick.fact_id);
    }
    db.prepare('UPDATE fact_conflict SET resolved=1, resolved_at=?, resolved_by=? WHERE conflict_id=?').run(now, by, conflictId);
    db.exec('COMMIT');
    return { ok: true, kept: pick.fact_id, dropped: drop.fact_id };
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, reason: 'error', error: String(err?.message ?? err) };
  }
}

/** 把某键下所有未解决冲突列出来，供整理报告。 */
export function listOpenConflicts(db, { limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT c.conflict_id AS conflictId, c.fact_a AS factA, c.fact_b AS factB, c.reason,
              c.created_at AS createdAt, fa.canonical_key AS key, fa.user_id AS userId
         FROM fact_conflict c
         JOIN fact fa ON fa.fact_id = c.fact_a
        WHERE c.resolved = 0
        ORDER BY c.created_at ASC LIMIT ?`,
    )
    .all(limit);
}
