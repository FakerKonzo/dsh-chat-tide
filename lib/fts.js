// bigram 分词与 FTS5 读写。
/**
 * 中文按 2-gram 切分、ASCII 连续串整体保留，用空格连接。
 * 单字中文保留原字，避免 1 字查询完全失配。
 */
export function bigram(text) {
  const out = [];
  const segs = String(text ?? '').match(/[\u3400-\u9fff]+|[A-Za-z0-9_]+/g) ?? [];
  for (const seg of segs) {
    if (/^[\u3400-\u9fff]+$/.test(seg)) {
      if (seg.length === 1) out.push(seg);
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    } else {
      out.push(seg.toLowerCase());
    }
  }
  return out.join(' ');
}

/** OR 版本：AND 全部命中太严，问句里的虚词会拖死召回。 */
export function matchExprOr(query) {
  const grams = bigram(query).split(' ').filter(Boolean);
  if (grams.length === 0) return null;
  return grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ');
}

/** 把查询词转成 FTS5 MATCH 表达式（每个 bigram 作为短语，AND 连接）。 */
export function matchExpr(query) {
  const grams = bigram(query).split(' ').filter(Boolean);
  if (grams.length === 0) return null;
  return grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' AND ');
}

export function indexFact(db, factId, value) {
  db.prepare('DELETE FROM fact_fts WHERE fact_id = ?').run(factId);
  const g = bigram(value);
  if (!g) return;
  db.prepare('INSERT INTO fact_fts(bigram_text, fact_id) VALUES (?, ?)').run(g, factId);
}

export function unindexFact(db, factId) {
  db.prepare('DELETE FROM fact_fts WHERE fact_id = ?').run(factId);
}

export function indexEvent(db, eventId, content) {
  db.prepare('DELETE FROM event_fts WHERE event_id = ?').run(eventId);
  const g = bigram(content);
  if (!g) return;
  db.prepare('INSERT INTO event_fts(bigram_text, event_id) VALUES (?, ?)').run(g, eventId);
}

export function unindexEvent(db, eventId) {
  db.prepare('DELETE FROM event_fts WHERE event_id = ?').run(eventId);
}

/** 事实检索：返回 { factId, score }，score 为 bm25（越小越相关，取负使越大越好）。 */
export function searchFacts(db, query, limit = 10) {
  const and = matchExpr(query);
  if (and === null) return [];
  const run = (expr) =>
    db
      .prepare(
        `SELECT fact_id AS factId, -bm25(fact_fts) AS score
           FROM fact_fts
          WHERE fact_fts MATCH ?
          ORDER BY score DESC
          LIMIT ?`,
      )
      .all(expr, limit);
  const hits = run(and);
  if (hits.length > 0) return hits;
  const or = matchExprOr(query);
  return or ? run(or) : [];
}

/** 事件检索：只查 event_fts（route_decision 等审计事件从不进索引）。 */
export function searchEvents(db, query, limit = 10) {
  const and = matchExpr(query);
  if (and === null) return [];
  const run = (expr) =>
    db
      .prepare(
        `SELECT e.event_id AS eventId, e.event_type AS eventType, e.content AS content, e.speaker_name AS speakerName, e.scope AS scope,
                e.conversation_key AS conversationKey, e.occurred_at AS occurredAt,
                -bm25(event_fts) AS score
           FROM event_fts
           JOIN event e ON e.event_id = event_fts.event_id
          WHERE event_fts MATCH ? AND e.status = 'active'
          ORDER BY score DESC
          LIMIT ?`,
      )
      .all(expr, limit);
  const hits = run(and);
  if (hits.length > 0) return hits;
  const or = matchExprOr(query);
  return or ? run(or) : [];
}
