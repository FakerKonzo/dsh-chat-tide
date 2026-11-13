// 静默三机制：B 被动禁言（持久化）、C 临时路由覆盖（到期自取消）。A 无状态在 egress 里。
const MINUTE = 60_000;

export const POLICY_MODES = new Set(['direct_only', 'no_ambient', 'mute_peer']);
export const MAX_POLICY_MS = 30 * MINUTE; // 硬上限，配置不可突破

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── B：被动禁言（配置面触发，权威级别高） ──
export function setSilence(db, { scopeType = 'peer', scopeId, ownerUserId = null, expiresAt = null, createdBy = 'config', reason = '' }, now = Date.now()) {
  const existing = db
    .prepare(`SELECT silence_id AS id FROM silence WHERE scope_type=? AND scope_id=? AND status='active'`)
    .get(scopeType, scopeId);
  if (existing) {
    db.prepare('UPDATE silence SET expires_at=?, updated_by=?, reason=? WHERE silence_id=?').run(expiresAt, createdBy, reason, existing.id);
    return { silenceId: existing.id, updated: true, expiresAt };
  }
  const silenceId = id('sil');
  db.prepare(
    `INSERT INTO silence(silence_id,scope_type,scope_id,owner_user_id,status,started_at,expires_at,created_by,updated_by,reason)
     VALUES (?,?,?,?, 'active', ?,?,?,?,?)`,
  ).run(silenceId, scopeType, scopeId, ownerUserId, now, expiresAt, createdBy, createdBy, reason);
  return { silenceId, updated: false, expiresAt };
}

export function activeSilence(db, { scopeType = 'peer', scopeId }, now = Date.now()) {
  const row = db
    .prepare(`SELECT * FROM silence WHERE scope_type=? AND scope_id=? AND status='active'`)
    .get(scopeType, scopeId);
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= now) {
    db.prepare(`UPDATE silence SET status='expired' WHERE silence_id=?`).run(row.silence_id);
    return null;
  }
  return { silenceId: row.silence_id, expiresAt: row.expires_at, ownerUserId: row.owner_user_id, reason: row.reason };
}

export function clearSilence(db, { scopeType = 'peer', scopeId }, by = 'config', now = Date.now()) {
  const res = db
    .prepare(`UPDATE silence SET status='cleared', updated_by=?, expires_at=? WHERE scope_type=? AND scope_id=? AND status='active'`)
    .run(by, now, scopeType, scopeId);
  return { cleared: res.changes > 0 };
}

// ── C：临时路由覆盖（LLM 工具设置，权限受限、到期自取消） ──
export function setRoutePolicy(db, { conversationKey, mode, ttlMs, setBy = 'model', triggerMessageId = null }, now = Date.now()) {
  if (!POLICY_MODES.has(mode)) return { ok: false, reason: 'bad-mode' };
  const ttl = Math.max(MINUTE, Math.min(Number(ttlMs) || MAX_POLICY_MS, MAX_POLICY_MS));
  const policyId = id('pol');
  db.prepare(
    `INSERT INTO route_policy(policy_id,conversation_key,mode,effective_from,expires_at,set_by,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(policyId, conversationKey, mode, now, now + ttl, setBy, now);
  return { ok: true, policyId, expiresAt: now + ttl, mode, clampedMs: ttl };
}

export function activePolicies(db, conversationKey, now = Date.now()) {
  return db
    .prepare(
      `SELECT policy_id AS policyId, mode, expires_at AS expiresAt, set_by AS setBy
         FROM route_policy
        WHERE conversation_key = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
    )
    .all(conversationKey, now);
}

/** 清掉过期策略并返回过期条数（供规则层自取消 + 写审计）。 */
export function reapExpiredPolicies(db, now = Date.now()) {
  const rows = db
    .prepare(`SELECT policy_id AS policyId, conversation_key AS conversationKey, mode FROM route_policy WHERE revoked_at IS NULL AND expires_at <= ?`)
    .all(now);
  for (const r of rows) db.prepare(`UPDATE route_policy SET revoked_at=? WHERE policy_id=?`).run(now, r.policyId);
  return rows;
}

export function revokePolicy(db, policyId, now = Date.now()) {
  const res = db.prepare('UPDATE route_policy SET revoked_at=? WHERE policy_id=? AND revoked_at IS NULL').run(now, policyId);
  return { revoked: res.changes > 0 };
}

/** 判断一条消息在现有策略下是否仍需继续路由。返回 'drop' 或 'pass'。 */
export function applyPolicies(policies, label) {
  for (const p of policies) {
    if (p.mode === 'mute_peer') return 'drop';
    if (p.mode === 'no_ambient' && label === 'ambient') return 'drop';
    if (p.mode === 'direct_only' && label !== 'direct' && label !== 'command') return 'drop';
  }
  return 'pass';
}
