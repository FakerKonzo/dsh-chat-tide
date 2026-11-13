// 存储层：schema、迁移、连接。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 13;

const SCHEMA_V1 = `
CREATE TABLE fact (
  fact_id          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  canonical_key    TEXT NOT NULL,
  subtype          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','superseded','deleted','pending_confirmation')),
  current_version  INTEGER NOT NULL,
  asserted_by      TEXT,
  subject_id       TEXT,
  attribution      TEXT,
  provenance_tier  TEXT NOT NULL CHECK (provenance_tier IN ('human_explicit','source_verifiable','agent_inferred')),
  valid_from       INTEGER,
  valid_to         INTEGER,
  occurred_at      INTEGER,
  observed_at      INTEGER,
  updated_at       INTEGER,
  source_record_id TEXT,
  conflicts_with   TEXT
);
CREATE UNIQUE INDEX idx_fact_active ON fact(user_id, entity_id, canonical_key, subtype) WHERE status = 'active';
CREATE INDEX idx_fact_key ON fact(user_id, entity_id, canonical_key);
CREATE INDEX idx_fact_status ON fact(status);

CREATE TABLE fact_version (
  fact_id                 TEXT NOT NULL REFERENCES fact(fact_id) ON DELETE CASCADE,
  version                 INTEGER NOT NULL,
  value                   TEXT NOT NULL,
  status                  TEXT NOT NULL,
  valid_from              INTEGER,
  valid_to                INTEGER,
  occurred_at             INTEGER,
  observed_at             INTEGER,
  created_at              INTEGER NOT NULL,
  embedding_model_version TEXT,
  embedding_pending       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fact_id, version)
);

CREATE TABLE fact_conflict (
  conflict_id TEXT PRIMARY KEY,
  fact_a      TEXT NOT NULL,
  fact_b      TEXT NOT NULL,
  reason      TEXT,
  resolved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX idx_conflict_open ON fact_conflict(resolved, created_at);

CREATE TABLE event (
  event_id                TEXT PRIMARY KEY,
  user_id                 TEXT,
  conversation_key        TEXT,
  event_type              TEXT NOT NULL,
  content                 TEXT,
  occurred_at             INTEGER,
  observed_at             INTEGER,
  correlation_id          TEXT,
  causation_id            TEXT,
  source_record_id        TEXT,
  status                  TEXT NOT NULL DEFAULT 'active',
  embedding_model_version TEXT,
  embedding_pending       INTEGER NOT NULL DEFAULT 0,
  indexed                 INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_event_type ON event(event_type);
CREATE INDEX idx_event_corr ON event(correlation_id);
CREATE INDEX idx_event_conv ON event(conversation_key, occurred_at);

CREATE TABLE raw_log (
  record_id       TEXT PRIMARY KEY,
  record_type     TEXT NOT NULL,
  adapter         TEXT,
  peer_id         TEXT,
  user_id         TEXT,
  conversation_key TEXT,
  platform        TEXT,
  correlation_id  TEXT,
  causation_id    TEXT,
  content_hash    TEXT,
  dedupe_key      TEXT NOT NULL,
  observed_at     INTEGER NOT NULL,
  payload         TEXT,
  payload_status  TEXT NOT NULL DEFAULT 'available',
  metadata        TEXT
);
CREATE INDEX idx_raw_conv ON raw_log(conversation_key, observed_at);
CREATE UNIQUE INDEX idx_raw_dedupe ON raw_log(adapter, peer_id, dedupe_key);

CREATE TABLE outbound (
  idempotency_key TEXT PRIMARY KEY,
  message_id      TEXT,
  generation_id   TEXT,
  send_status     TEXT NOT NULL CHECK (send_status IN ('SUBMITTED','SUPPRESSED','FAILED_LOCAL')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_outbound_gen ON outbound(generation_id);

CREATE TABLE job (
  job_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  payload      TEXT,
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_job_idem ON job(idem_key);
CREATE INDEX idx_job_state ON job(state, next_at);

CREATE TABLE tombstone (
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

-- 全文索引：普通 FTS5 表，存 bigram 变换后的文本；删除按 ref 直接删行（不用外部内容表）
CREATE VIRTUAL TABLE fact_fts USING fts5(bigram_text, fact_id UNINDEXED, tokenize='unicode61');
CREATE VIRTUAL TABLE event_fts USING fts5(bigram_text, event_id UNINDEXED, tokenize='unicode61');
`;

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  // allowExtension 必须在这里给：node:sqlite 默认禁止加载扩展，sqlite-vec 要靠它
  const db = new DatabaseSync(file, { allowExtension: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

const SCHEMA_V2 = `
CREATE TABLE silence (
  silence_id    TEXT PRIMARY KEY,
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  owner_user_id TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  started_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  created_by    TEXT,
  updated_by    TEXT,
  reason        TEXT
);
CREATE UNIQUE INDEX idx_silence_active ON silence(scope_type, scope_id) WHERE status = 'active';

CREATE TABLE route_policy (
  policy_id        TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  mode             TEXT NOT NULL,
  effective_from   INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  set_by           TEXT,
  created_at       INTEGER NOT NULL,
  revoked_at       INTEGER
);
CREATE INDEX idx_policy_active ON route_policy(conversation_key, revoked_at, expires_at);
`;


const SCHEMA_V3 = `
CREATE TABLE exemplar (
  exemplar_id TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  label       TEXT NOT NULL CHECK (label IN ('relevant_ambient','irrelevant_ambient')),
  version     TEXT NOT NULL DEFAULT 'v1',
  approved    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_exemplar_label ON exemplar(label, approved);

CREATE TABLE route_budget (
  conversation_key TEXT NOT NULL,
  window_start     INTEGER NOT NULL,
  spent            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_key, window_start)
);
`;

const SCHEMA_V4 = `
ALTER TABLE fact_version ADD COLUMN surface TEXT;
UPDATE fact_version SET surface = value WHERE surface IS NULL;
`;

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS attention (
  attention_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  label TEXT NOT NULL,
  note TEXT,
  weight REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attention_status ON attention(status, weight DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS attention_fts USING fts5(
  attention_id UNINDEXED, text, tokenize='unicode61'
);
`;

const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const SCHEMA_V7 = `
ALTER TABLE event ADD COLUMN speaker_name TEXT;
`;

const SCHEMA_V8 = `
ALTER TABLE tombstone ADD COLUMN reason TEXT;
`;

const SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS people (
  openid TEXT PRIMARY KEY,
  nickname TEXT,
  relation TEXT,
  first_seen INTEGER,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS alias (
  alias_key TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL
);
`;

const SCHEMA_V10 = `
ALTER TABLE event ADD COLUMN scope TEXT;
-- 群/私聊判定交给调用方（conversation_key 的形态因适配器而异），这里只兜底标记
UPDATE event SET scope = 'other' WHERE scope IS NULL;
`;

const SCHEMA_V11 = `
ALTER TABLE fact ADD COLUMN scope TEXT;
UPDATE fact SET scope = (
  SELECT MAX(e.scope) FROM raw_log r
    JOIN event e ON e.conversation_key = r.conversation_key
   WHERE r.record_id = fact.source_record_id
) WHERE scope IS NULL;
UPDATE fact SET scope = 'unknown' WHERE scope IS NULL;
`;

const SCHEMA_V12 = `
CREATE TABLE IF NOT EXISTS image_cache (
  sha1 TEXT PRIMARY KEY,
  path TEXT,
  media_type TEXT,
  semantic TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
`;

const SCHEMA_V13 = `
CREATE TABLE IF NOT EXISTS topic_candidate (
  topic_key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
`;

const MIGRATIONS = { 1: SCHEMA_V1, 2: SCHEMA_V2, 3: SCHEMA_V3, 4: SCHEMA_V4, 5: SCHEMA_V5, 6: SCHEMA_V6, 7: SCHEMA_V7, 8: SCHEMA_V8, 9: SCHEMA_V9, 10: SCHEMA_V10, 11: SCHEMA_V11, 12: SCHEMA_V12, 13: SCHEMA_V13 };

export function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (sql) db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已回滚 */
    }
    throw err;
  }
}
