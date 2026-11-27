// 向量层：sqlite-vec 加载、vec0 表、写入与 KNN。
import { getLoadablePath } from 'sqlite-vec';

export const VEC_DIM = 512;

const toBlob = (f32) => new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);

/** 尝试加载扩展；失败返回 false（上层降级到 FTS）。 */
export function loadVec(db) {
  try {
    db.loadExtension(getLoadablePath());
    return true;
  } catch {
    return false;
  }
}

export function ensureVecTables(db, dim = VEC_DIM) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_fact USING vec0(embedding float[${dim}])`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_event USING vec0(embedding float[${dim}])`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_exemplar USING vec0(embedding float[${dim}])`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_attention USING vec0(embedding float[${dim}])`);
}

/**
 * 写入/覆盖一个向量。vec0 不支持稳定的 UPDATE 语义，统一 DELETE + INSERT。
 * rowid 由调用方给出（用 fact_version.rowid / event.rowid），保证与主表一一对应。
 */
export function putVector(db, table, rowid, f32) {
  db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(rowid));
  db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`).run(BigInt(rowid), toBlob(f32));
}

export function deleteVector(db, table, rowid) {
  db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(rowid));
}

/** KNN：返回 [{ rowid, distance }]，distance 为 sqlite-vec 的 L2。 */
export function knn(db, table, f32, k = 10) {
  return db
    .prepare(`SELECT rowid, distance FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
    .all(toBlob(f32), k);
}

/** 先限定可用的经历和当前事实版本，再在这个集合中取最近的 k 条。 */
export function knnMemory(db, table, vector, k, scopes) {
  const facts = table === 'vec_fact';
  if (!facts && table !== 'vec_event') throw new Error('unknown memory table');
  const allowed = facts
    ? "SELECT v.rowid FROM fact_version v JOIN fact f ON f.fact_id=v.fact_id AND f.current_version=v.version WHERE f.status='active' AND f.subtype!='rule'"
    : "SELECT e.rowid FROM event e WHERE e.status='active'";
  const scope = facts ? 'f.scope' : 'e.scope';
  const filter = scopes ? ` AND COALESCE(${scope}, 'unknown') IN (${scopes.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT rowid, distance FROM ${table}
    WHERE embedding MATCH ? AND k = ? AND rowid IN (${allowed}${filter}) ORDER BY distance`)
    .all(toBlob(vector), k, ...(scopes ?? []));
}

/** sqlite-vec 的 L2 距离 → 余弦（单位向量下 d^2 = 2 - 2cos）。 */
export function distanceToCosine(d) {
  const c = 1 - (d * d) / 2;
  return Math.max(-1, Math.min(1, c));
}

/** 余弦相似度：向量已归一化时等价于点积。 */
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
