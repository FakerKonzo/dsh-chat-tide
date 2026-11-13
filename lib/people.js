// 人表与同义键：稳定标识 + 昵称展示 + 键归一
export function upsertPerson(db, { openid, nickname, relation = null, at = Date.now() }) {
  if (!openid) return;
  const row = db.prepare('SELECT openid, first_seen AS firstSeen FROM people WHERE openid=?').get(openid);
  if (!row) {
    db.prepare('INSERT INTO people(openid, nickname, relation, first_seen, last_seen) VALUES (?,?,?,?,?)').run(
      openid,
      nickname ?? null,
      relation,
      at,
      at,
    );
    return;
  }
  db.prepare('UPDATE people SET nickname=COALESCE(?, nickname), relation=COALESCE(?, relation), last_seen=? WHERE openid=?').run(
    nickname ?? null,
    relation,
    at,
    openid,
  );
}

export function getPerson(db, openid) {
  try {
    return db.prepare('SELECT openid, nickname, relation FROM people WHERE openid=?').get(openid) ?? null;
  } catch {
    return null;
  }
}

export function nicknameOf(db, openid, fallback = null) {
  return getPerson(db, openid)?.nickname ?? fallback;
}

/** 键归一：别名表命中就用规范键，避免同一事实分叉成多个键。 */
export function canonicalKeyOf(db, key) {
  try {
    const row = db.prepare('SELECT canonical_key AS k FROM alias WHERE alias_key=?').get(key);
    return row?.k ?? key;
  } catch {
    return key;
  }
}

export function addAlias(db, aliasKey, canonicalKey) {
  if (!aliasKey || !canonicalKey || aliasKey === canonicalKey) return;
  db.prepare('INSERT INTO alias(alias_key, canonical_key) VALUES (?,?) ON CONFLICT(alias_key) DO UPDATE SET canonical_key=excluded.canonical_key').run(
    aliasKey,
    canonicalKey,
  );
}

export function listPeople(db, { limit = 100 } = {}) {
  return db.prepare('SELECT openid, nickname, relation, first_seen AS firstSeen, last_seen AS lastSeen FROM people ORDER BY last_seen DESC LIMIT ?').all(limit);
}
