// 关注点自增长：探索唤醒里反复出现的说法，攒够次数升成关注点
import { createHash } from 'node:crypto';

const key = (text) => createHash('sha1').update(String(text ?? '').trim().slice(0, 120)).digest('hex');

/** 去掉聊天信封与提及，只留可读的话题文本。 */
export function cleanTopicText(text) {
  let t = String(text ?? '');
  t = t.replace(/\[Chat history begins\][\s\S]*?\[Chat history ends\]/gi, ' ');
  t = t.replace(/\[Current message\]/gi, ' ');
  t = t.replace(/\[[^\]\n]{1,32}?\s*\([0-9A-Za-z]{10,}\)\]/g, ' '); // [昵称 (openid)]
  t = t.replace(/<@[^>]{1,64}>/g, ' ');
  t = t.replace(/\(@you\)/gi, ' ');
  t = t.replace(/\[Quoted message begins\][\s\S]*?\[Quoted message ends\]/gi, ' ');
  t = t.replace(/^-\s*Image:\s*.+$/gim, ' ');
  t = t.replace(/^-\s*File:\s*.+$/gim, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function recordTopicCandidate(db, text, { now = Date.now() } = {}) {
  const clean = cleanTopicText(text);
  if (clean.length < 4 || clean.length > 200) return null;
  const k = key(clean);
  try {
    db.prepare(
      `INSERT INTO topic_candidate(topic_key, text, count, first_seen, last_seen)
       VALUES (?,?,1,?,?)
       ON CONFLICT(topic_key) DO UPDATE SET
         count = topic_candidate.count + 1,
         last_seen = excluded.last_seen`,
    ).run(k, clean, now, now);
    return k;
  } catch {
    return null;
  }
}

/**
 * 把「反复出现」的候选升成关注点。
 * 只升 count >= minCount 且最近 maxAgeDays 内出现过的，单轮最多 max 条，防止一次灌爆。
 */
export function promoteCandidates(db, { minCount = 2, maxAgeDays = 7, max = 3, now = Date.now(), addAttention } = {}) {
  if (typeof addAttention !== 'function') return { promoted: 0, checked: 0 };
  let rows = [];
  try {
    rows = db
      .prepare('SELECT topic_key AS k, text, count FROM topic_candidate WHERE count >= ? AND last_seen >= ? ORDER BY count DESC LIMIT ?')
      .all(minCount, now - maxAgeDays * 86_400_000, max);
  } catch {
    return { promoted: 0, checked: 0 };
  }
  let promoted = 0;
  for (const r of rows) {
    try {
      addAttention(db, { kind: 'topic', label: r.text, weight: 0.4, ttlDays: 21 });
      db.prepare('DELETE FROM topic_candidate WHERE topic_key = ?').run(r.k);
      promoted++;
    } catch {
      /* 单条失败不影响其他 */
    }
  }
  return { promoted, checked: rows.length };
}

export function listCandidates(db, { limit = 20 } = {}) {
  try {
    return db.prepare('SELECT text, count, last_seen AS lastSeen FROM topic_candidate ORDER BY count DESC LIMIT ?').all(limit);
  } catch {
    return [];
  }
}
