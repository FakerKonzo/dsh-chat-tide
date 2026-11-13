// 关注点（attention）：只有这些主题值得主动搭话；其余只记录，不唤醒。
import { createHash } from 'node:crypto';
import { matchExpr, bigram } from './fts.js';
import { scrubIdentifiers } from './scrub.js';

const now = () => Date.now();

/** 默认屏蔽：开发过程、插件实现、模型自身运作不算主人的关注点 */
const DEFAULT_BLOCK = ['插件', '记忆系统', 'prompt', '提示词', '模型运作', '系统设计', '时间窗', '候选集', '向量', '接口', '写入工具', '关注点机制', '关注点', '污染风险'];

function isBlocked(label, blocked) {
  const t = String(label ?? '');
  const list = [...DEFAULT_BLOCK, ...(blocked ?? [])];
  return list.some((p) => p && t.includes(p));
}

export function attentionIdFor(label) {
  return 'att-' + createHash('sha1').update(String(label).trim()).digest('hex').slice(0, 16);
}

function indexAttention(db, attentionId, text) {
  try {
    db.prepare('DELETE FROM attention_fts WHERE attention_id = ?').run(attentionId);
    db.prepare('INSERT INTO attention_fts(attention_id, text) VALUES (?, ?)').run(attentionId, bigram(text));
  } catch {
    /* 索引失败不阻断 */
  }
}

export function addAttention(db, { kind = 'topic', refId = null, label, note = null, weight = 0.5, expiresAt = null, ttlDays = null, blockPatterns = [] }) {
  const clean = scrubIdentifiers(label);
  note = note === null || note === undefined ? note : scrubIdentifiers(note);
  if (!clean) return null;
  if (kind === 'topic' && isBlocked(clean, blockPatterns)) return null;
  const id = attentionIdFor(clean);
  const existing = db.prepare('SELECT attention_id, weight FROM attention WHERE attention_id = ?').get(id);
  const exp = expiresAt ?? (ttlDays ? now() + ttlDays * 86_400_000 : null);
  if (existing) {
    db.prepare('UPDATE attention SET weight = MAX(weight, ?), note = COALESCE(?, note), status = ? WHERE attention_id = ?').run(
      weight,
      note,
      'active',
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO attention(attention_id, kind, ref_id, label, note, weight, status, hits, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,0,?,?)`,
    ).run(id, kind, refId, clean, note, weight, 'active', now(), exp);
  }
  indexAttention(db, id, [clean, note].filter(Boolean).join(' '));
  return id;
}

export function listAttention(db, { status = 'active', limit = 50 } = {}) {
  return db
    .prepare('SELECT attention_id AS id, kind, label, note, weight, status, hits, last_hit_at AS lastHitAt FROM attention WHERE status = ? ORDER BY weight DESC, created_at DESC LIMIT ?')
    .all(status, limit);
}

export function retireAttention(db, id, reason = null) {
  db.prepare("UPDATE attention SET status = 'retired', note = COALESCE(?, note) WHERE attention_id = ?").run(reason, id);
  try {
    db.prepare('DELETE FROM attention_fts WHERE attention_id = ?').run(id);
  } catch {
    /* ignore */
  }
}

export function bumpAttentionHit(db, id) {
  db.prepare('UPDATE attention SET hits = hits + 1, last_hit_at = ? WHERE attention_id = ?').run(now(), id);
}

/** 查询是否落在某个关注点上；返回命中项或 null。 */
export function matchAttention(db, text, { threshold = 2 } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const grams = [...new Set(bigram(clean).split(' ').filter((g) => g.length >= 2))];
  if (!grams.length) return null;
  let rows = [];
  try {
    const expr = matchExpr(clean);
    if (expr) {
      rows = db
        .prepare(
          `SELECT a.attention_id AS id, a.label, a.note, a.weight, f.text
             FROM attention_fts f JOIN attention a ON a.attention_id = f.attention_id
            WHERE attention_fts MATCH ? AND a.status = 'active'
            ORDER BY a.weight DESC LIMIT 10`,
        )
        .all(expr);
    }
  } catch {
    rows = [];
  }
  if (!rows.length) {
    rows = db
      .prepare("SELECT attention_id AS id, label, note, weight, NULL AS text FROM attention WHERE status = 'active' ORDER BY weight DESC LIMIT 50")
      .all();
  }
  let best = null;
  for (const r of rows) {
    const hay = String(r.text ?? '').replace(/ /g, '') + (r.label ?? '') + (r.note ?? '');
    const hit = grams.filter((g) => hay.includes(g)).length;
    if (hit >= threshold && (!best || hit > best.hit)) best = { id: r.id, label: r.label, note: r.note, weight: r.weight, hit };
  }
  return best;
}

/** 巡检：过期/低权重的关注点自动退休，保留最多 maxActive 条。 */
export function pruneAttention(db, { now: t = now(), maxActive = 80, expireDays = 30 } = {}) {
  const expired = db
    .prepare("SELECT attention_id AS id FROM attention WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?")
    .all(t);
  for (const r of expired) retireAttention(db, r.id, 'expired');

  const stale = db
    .prepare(
      `SELECT attention_id AS id FROM attention
        WHERE status = 'active' AND hits = 0 AND created_at < ?
        ORDER BY created_at ASC LIMIT 50`,
    )
    .all(t - expireDays * 86_400_000);
  for (const r of stale) retireAttention(db, r.id, 'stale');

  const over = db
    .prepare(
      `SELECT attention_id AS id FROM attention WHERE status = 'active'
        ORDER BY weight ASC, last_hit_at ASC NULLS FIRST LIMIT 500`,
    )
    .all();
  let retired = 0;
  const activeCount = db.prepare("SELECT count(*) c FROM attention WHERE status = 'active'").get().c;
  for (const r of over) {
    if (activeCount - retired <= maxActive) break;
    retireAttention(db, r.id, 'over-capacity');
    retired++;
  }
  return { expired: expired.length, stale: stale.length, overCapacity: retired };
}

/** 关注点向量化的文本：主题 + 备注 + 关键词。 */
export function attentionVectorText(row) {
  return [row.label, row.note].filter(Boolean).join(' ');
}

/** attention 的隐式 rowid（vec_attention 用它对齐）。 */
export function attentionRowid(db, attentionId) {
  try {
    return db.prepare('SELECT rowid FROM attention WHERE attention_id = ?').get(attentionId)?.rowid ?? null;
  } catch {
    return null;
  }
}

/** 还没有向量的活跃关注点（启动补算用）。 */
export function attentionNeedingVector(db, limit = 200) {
  return db
    .prepare(
      `SELECT a.rowid AS rowid, a.attention_id AS id, a.label, a.note
         FROM attention a
        WHERE a.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM vec_attention v WHERE v.rowid = a.rowid)
        LIMIT ?`,
    )
    .all(limit);
}
