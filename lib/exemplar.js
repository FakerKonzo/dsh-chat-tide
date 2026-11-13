// 示例库：正反例由人工/离线审核后入库，路由事件不自动回流。
export const EXEMPLAR_LABELS = new Set(['relevant_ambient', 'irrelevant_ambient']);

function newId() {
  return `ex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addExemplar(db, { text, label, version = 'v1', approved = true }, now = Date.now()) {
  if (!text || !EXEMPLAR_LABELS.has(label)) return { ok: false, reason: 'bad-input' };
  const exemplarId = newId();
  db.prepare(
    `INSERT INTO exemplar(exemplar_id,text,label,version,approved,created_at) VALUES (?,?,?,?,?,?)`,
  ).run(exemplarId, String(text).slice(0, 1000), label, version, approved ? 1 : 0, now);
  const row = db.prepare('SELECT rowid FROM exemplar WHERE exemplar_id = ?').get(exemplarId);
  return { ok: true, exemplarId, rowid: row?.rowid };
}

export function listExemplars(db, { approvedOnly = true, limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT exemplar_id AS exemplarId, text, label, version, approved, created_at AS createdAt
         FROM exemplar ${approvedOnly ? 'WHERE approved = 1' : ''}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function removeExemplar(db, exemplarId) {
  const row = db.prepare('SELECT rowid FROM exemplar WHERE exemplar_id = ?').get(exemplarId);
  if (row) {
    // 示例向量表只在 sqlite-vec 可用时存在
    const vecTable = db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_exemplar'").get();
    if (vecTable) db.prepare('DELETE FROM vec_exemplar WHERE rowid = ?').run(BigInt(row.rowid));
  }
  const res = db.prepare('DELETE FROM exemplar WHERE exemplar_id = ?').run(exemplarId);
  return { removed: res.changes > 0 };
}

/**
 * 用示例库给灰区补一脚：返回最相近的已审核示例。
 * knn 由调用方注入（依赖 sqlite-vec），没有向量时返回 null。
 */
export function matchExemplar({ knnFn, queryVec, toCosine, k = 3 }) {
  if (!knnFn || !queryVec) return null;
  const near = knnFn(k, queryVec);
  if (!near?.length) return null;
  return near.map((r) => ({ rowid: r.rowid, score: toCosine(r.distance) }));
}
