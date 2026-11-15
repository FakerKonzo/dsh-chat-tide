// 事实层：证据分级、时间仲裁、CAS 写入、插入竞态重试、冲突标记。
import { indexFact, unindexFact } from './fts.js';
import { scrubIdentifiers } from './scrub.js';

/** 删掉某个事实所有版本的向量（删除事实时用）。 */
export function pruneVectorsForFact(db, factId) {
  try {
    const rows = db.prepare('SELECT rowid FROM fact_version WHERE fact_id = ?').all(factId);
    for (const r of rows) {
      try {
        db.prepare('DELETE FROM vec_fact WHERE rowid = ?').run(BigInt(r.rowid));
      } catch {
        /* 向量表不存在则跳过 */
      }
    }
  } catch {
    /* ignore */
  }
}

/** 删掉某一版本的向量（覆盖写时用，避免旧值继续参与 KNN）。 */
export function pruneVectorForVersion(db, factId, version) {
  try {
    const row = db.prepare('SELECT rowid FROM fact_version WHERE fact_id = ? AND version = ?').get(factId, version);
    if (row) db.prepare('DELETE FROM vec_fact WHERE rowid = ?').run(BigInt(row.rowid));
  } catch {
    /* ignore */
  }
}
import { tx } from './db.js';

export const TIER_RANK = { human_explicit: 3, source_verifiable: 2, agent_inferred: 1 };
export const MAX_ATTEMPTS = 3;

const now = () => Date.now();

function readActive(db, { userId, entityId, canonicalKey, subtype }) {
  return db
    .prepare(
      `SELECT * FROM fact
        WHERE user_id = ? AND entity_id = ? AND canonical_key = ? AND subtype = ? AND status = 'active'
        LIMIT 1`,
    )
    .get(userId, entityId, canonicalKey, subtype);
}

/**
 * 冲突裁决（§4.4）：先比来源层级，同层级再比 occurred_at。
 * 返回 'replace'（新事实胜）或 'conflict'（裁决不了，进 pending）。
 */
export function adjudicate(candidate, current) {
  if (!current) return 'replace';
  const ct = TIER_RANK[candidate.provenanceTier] ?? 0;
  const et = TIER_RANK[current.provenance_tier] ?? 0;
  if (ct > et) return 'replace';
  if (ct < et) return 'conflict'; // 低层级不得覆盖高层级，但先按冲突保留
  const cAt = candidate.occurredAt ?? candidate.observedAt ?? now();
  const eAt = current.occurred_at ?? current.observed_at ?? 0;
  if (cAt > eAt) return 'replace';
  if (cAt < eAt) return 'conflict';
  return 'conflict';
}

function insertVersion(db, factId, version, value, status, cand, t = now()) {
  // surface：证据原句，用于中文语义召回（canonical_key 是英文，单独不可检索）
  const surface = cand.surface ?? cand.evidence ?? null;
  db.prepare(
    `INSERT INTO fact_version(fact_id,version,value,status,valid_from,valid_to,occurred_at,observed_at,created_at,
                              embedding_model_version,embedding_pending,surface)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    factId,
    version,
    value,
    status,
    cand.validFrom ?? null,
    cand.validTo ?? null,
    cand.occurredAt ?? null,
    cand.observedAt ?? t,
    t,
    cand.embeddingModelVersion ?? null,
    cand.embeddingPending ? 1 : 0,
    surface,
  );
  return db.prepare('SELECT rowid FROM fact_version WHERE fact_id = ? AND version = ?').get(factId, version).rowid;
}

function newFactId() {
  return `fact-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 写入一个事实候选。
 * @returns {{factId,status,version,outcome,versionRowid,conflictWith?}}
 * outcome: created | replaced | conflicted | skipped
 */
export function writeFact(db, rawCand) {
  const cand = { ...rawCand, value: scrubIdentifiers(rawCand.value) };
  const t0 = now();
  const base = {
    userId: cand.userId,
    entityId: cand.entityId ?? cand.userId,
    canonicalKey: cand.canonicalKey,
    subtype: cand.subtype ?? 'profile',
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = readActive(db, base);
    const verdict = adjudicate(cand, current);

    if (!current) {
      // 插入竞态：唯一约束冲突 → 重读后重试
      try {
        return tx(db, () => {
          const factId = newFactId();
          db.prepare(
            `INSERT INTO fact(fact_id,user_id,entity_id,canonical_key,subtype,status,current_version,
                              asserted_by,subject_id,attribution,provenance_tier,valid_from,valid_to,
                              occurred_at,observed_at,updated_at,source_record_id,scope,applies_to)
             VALUES (?,?,?,?,?, 'active', 1, ?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            factId,
            base.userId,
            base.entityId,
            base.canonicalKey,
            base.subtype,
            cand.assertedBy ?? null,
            cand.subjectId ?? base.userId,
            cand.attribution ?? null,
            cand.provenanceTier,
            cand.validFrom ?? null,
            cand.validTo ?? null,
            cand.occurredAt ?? null,
            cand.observedAt ?? t0,
            t0,
            cand.sourceRecordId ?? null,
            cand.scope ?? 'unknown',
            cand.appliesTo ?? 'any',
          );
          const rowid = insertVersion(db, factId, 1, cand.value, 'active', cand, t0);
          indexFact(db, factId, cand.value);
          return { factId, status: 'active', version: 1, outcome: 'created', versionRowid: rowid };
        });
      } catch (err) {
        if (/UNIQUE/.test(String(err?.message))) continue;
        throw err;
      }
    }

    if (verdict === 'replace') {
      return tx(db, () => {
        const nextVersion = current.current_version + 1;
        const prevValue = db
          .prepare('SELECT value FROM fact_version WHERE fact_id=? AND version=?')
          .get(current.fact_id, current.current_version)?.value;
        db.prepare(`UPDATE fact_version SET status='superseded', valid_to=? WHERE fact_id=? AND version=?`).run(
          cand.validFrom ?? t0,
          current.fact_id,
          current.current_version,
        );
        // 旧事实的有效区间截止到新事实生效点
        pruneVectorForVersion(db, current.fact_id, current.current_version);
        const rowid = insertVersion(db, current.fact_id, nextVersion, cand.value, 'active', cand, t0);
        db.prepare(
          `UPDATE fact SET status='active', current_version=?, updated_at=?, asserted_by=?, subject_id=?,
                            attribution=?, provenance_tier=?, valid_from=?, valid_to=?, occurred_at=?,
                            observed_at=?, source_record_id=?, scope=?, conflicts_with=NULL
            WHERE fact_id=?`,
        ).run(
          nextVersion,
          t0,
          cand.assertedBy ?? current.asserted_by,
          cand.subjectId ?? current.subject_id,
          cand.attribution ?? current.attribution,
          cand.provenanceTier,
          cand.validFrom ?? null,
          cand.validTo ?? null,
          cand.occurredAt ?? null,
          cand.observedAt ?? t0,
          cand.sourceRecordId ?? null,
          cand.scope ?? current.scope ?? 'unknown',
          current.fact_id,
        );
        indexFact(db, current.fact_id, cand.value);
        return {
          factId: current.fact_id,
          status: 'active',
          version: nextVersion,
          outcome: 'replaced',
          versionRowid: rowid,
          previousValue: prevValue,
        };
      });
    }

    // conflict：新候选进 pending_confirmation，旧 active 保持，写冲突记录
    return tx(db, () => {
      const factId = newFactId();
      db.prepare(
        `INSERT INTO fact(fact_id,user_id,entity_id,canonical_key,subtype,status,current_version,
                          asserted_by,subject_id,attribution,provenance_tier,valid_from,valid_to,
                          occurred_at,observed_at,updated_at,source_record_id,conflicts_with)
         VALUES (?,?,?,?,?, 'pending_confirmation', 1, ?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        factId,
        base.userId,
        base.entityId,
        base.canonicalKey,
        base.subtype,
        cand.assertedBy ?? null,
        cand.subjectId ?? base.userId,
        cand.attribution ?? null,
        cand.provenanceTier,
        cand.validFrom ?? null,
        cand.validTo ?? null,
        cand.occurredAt ?? null,
        cand.observedAt ?? t0,
        t0,
        cand.sourceRecordId ?? null,
        JSON.stringify([current.fact_id]),
      );
      const rowid = insertVersion(db, factId, 1, cand.value, 'pending_confirmation', cand, t0);
      // 双向标记
      const prev = current.conflicts_with ? JSON.parse(current.conflicts_with) : [];
      db.prepare('UPDATE fact SET conflicts_with = ? WHERE fact_id = ?').run(
        JSON.stringify([...new Set([...prev, factId])]),
        current.fact_id,
      );
      db.prepare(
        `INSERT INTO fact_conflict(conflict_id,fact_a,fact_b,reason,resolved,created_at)
         VALUES (?,?,?,?,0,?)`,
      ).run(`conf-${factId}`, current.fact_id, factId, 'tier/time undecidable', t0);
      return { factId, status: 'pending_confirmation', version: 1, outcome: 'conflicted', versionRowid: rowid, conflictWith: current.fact_id };
    });
  }
  return { outcome: 'skipped', reason: 'insert-race-exhausted' };
}

export function confirmFact(db, factId, value) {
  return tx(db, () => {
    const row = db
      .prepare(
        `SELECT f.*, v.value AS cur_value FROM fact f
           JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version
          WHERE f.fact_id=? AND f.status='pending_confirmation'`,
      )
      .get(factId);
    if (!row) return { outcome: 'not-found' };
    const active = readActive(db, {
      userId: row.user_id,
      entityId: row.entity_id,
      canonicalKey: row.canonical_key,
      subtype: row.subtype,
    });
    const nextVersion = row.current_version + 1;
    if (active && active.fact_id !== factId) {
      db.prepare(`UPDATE fact SET status='superseded', updated_at=? WHERE fact_id=?`).run(now(), active.fact_id);
    }
    insertVersion(db, factId, nextVersion, value ?? row.cur_value, 'active', {}, now());
    db.prepare(`UPDATE fact SET status='active', current_version=?, updated_at=? WHERE fact_id=?`).run(
      nextVersion,
      now(),
      factId,
    );
    indexFact(db, factId, value ?? row.cur_value);
    return { outcome: 'confirmed', factId, version: nextVersion };
  });
}

export function deleteFact(db, factId, { reason = 'manual' } = {}) {
  return tx(db, () => {
    const row = db.prepare('SELECT status, provenance_tier AS tier FROM fact WHERE fact_id=?').get(factId);
    if (!row) return { outcome: 'not-found' };
    db.prepare(`UPDATE fact SET status='deleted', updated_at=? WHERE fact_id=?`).run(now(), factId);
    db.prepare(`UPDATE fact_version SET status='deleted' WHERE fact_id=?`).run(factId);
    unindexFact(db, factId);
    pruneVectorsForFact(db, factId);
    // 删除审计：为什么删、什么时候删
    db.prepare('INSERT INTO tombstone(target_type, target_id, created_at, reason) VALUES (?,?,?,?)').run('fact', factId, now(), reason);
    return { outcome: 'deleted', reason };
  });
}

/** 读当前有效值（固定一次 join，禁止 N+1）。 */
export function getCurrentFact(db, factId) {
  return db
    .prepare(
      `SELECT f.fact_id AS factId, f.user_id AS userId, f.entity_id AS entityId, f.canonical_key AS canonicalKey,
              f.subtype, f.status, f.current_version AS version, f.provenance_tier AS tier,
              f.valid_from AS validFrom, f.valid_to AS validTo, f.occurred_at AS occurredAt,
              f.conflicts_with AS conflictsWith, v.value
         FROM fact f
         JOIN fact_version v ON v.fact_id = f.fact_id AND v.version = f.current_version
        WHERE f.fact_id = ?`,
    )
    .get(factId);
}

/** 按键取候选（含历史版本），供 fact_get 返回候选集。 */
export function getCandidates(db, { userId, entityId, canonicalKey, subtype }) {
  return db
    .prepare(
      `SELECT f.fact_id AS factId, f.status, f.current_version AS version, f.provenance_tier AS tier,
              f.valid_from AS validFrom, f.valid_to AS validTo, f.occurred_at AS occurredAt,
              v.value, v.status AS versionStatus
         FROM fact f
         JOIN fact_version v ON v.fact_id = f.fact_id AND v.version = f.current_version
        WHERE f.user_id = ? AND f.entity_id = ? AND f.canonical_key = ? AND (? IS NULL OR f.subtype = ?)
        ORDER BY f.updated_at DESC`,
    )
    .all(userId, entityId, canonicalKey, subtype ?? null, subtype ?? null);
}
