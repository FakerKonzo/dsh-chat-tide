// 运行时可改配置：页面写入 settings 表，插件读取后覆盖静态配置。
// 允许的键与范围来自 schema.js（单一来源），避免前后端键名漂移。

import { DEFAULTS, RANGES, GROUPS, keyTypes } from './schema.js';

const TIME_KEYS = new Set(['routing.quietStart', 'routing.quietEnd']);
const TEXT_KEYS = new Set(['scope.cwd', 'scope.sessionIds']);
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

const PATHS = Object.freeze(
  Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, key.split('.')])),
);

export function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

export function knownKeyTypes() {
  return keyTypes();
}

function isBool(key) {
  return typeof DEFAULTS[key] === 'boolean';
}

/**
 * 字段类型以 schema 的分组声明为准（text / select / num / bool）。
 * 以前这里维护一份手写清单，新加的文本键没进清单就会被当数字校验，
 * 存个 openid 直接报 not-a-number——列出所有特例是治不完的。
 */
function declaredType(key) {
  for (const group of GROUPS) {
    for (const field of group.fields ?? []) {
      if (field?.[0] === key) return field[2];
    }
  }
  return null;
}

function isTextKey(key) {
  const t = declaredType(key);
  if (t === 'text' || t === 'select' || t === 'owner' || t === 'sessions') return true;
  return TEXT_KEYS.has(key);
}

function parseStored(key, raw) {
  if (isBool(key)) return raw === '1';
  if (isTextKey(key) || declaredType(key) === 'time' || TIME_KEYS.has(key)) return String(raw);
  return Number(raw);
}

export function getOverrides(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) {
      if (!isKnownKey(r.key)) continue;
      out[r.key] = parseStored(r.key, r.value);
    }
    return out;
  } catch {
    return {};
  }
}

function validTime(text) {
  const m = TIME_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const revisions = new WeakMap();
export const settingsRevision = (db) => revisions.get(db) ?? 0;

export function setOverride(db, key, raw) {
  if (!isKnownKey(key)) return { ok: false, error: 'unknown-key' };
  let stored;
  if (isBool(key)) {
    stored = raw === true || raw === '1' || raw === 'on' || raw === 'true' ? '1' : '0';
  } else if (key === 'scope.mode') {
    const v = String(raw ?? '').trim();
    if (!['follow', 'workspace', 'sessions', 'off', 'qq', 'preset', 'all'].includes(v)) {
      return { ok: false, error: 'bad-value' };
    }
    stored = v;
  } else if (isTextKey(key)) {
    // 文本类：去空白，限长。下拉的值再校验一遍，免得写进未知取值
    const t = declaredType(key);
    stored = String(raw ?? '').trim().slice(0, 2000);
    if (t === 'select') {
      const field = GROUPS.flatMap((g) => g.fields ?? []).find((x) => x[0] === key);
      const allowed = field?.[3];
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(stored)) {
        return { ok: false, error: 'bad-value' };
      }
    }
  } else if (declaredType(key) === 'time' || TIME_KEYS.has(key)) {
    const t = validTime(raw);
    if (!t) return { ok: false, error: 'bad-time' };
    stored = t;
  } else {
    const n = Number(raw);
    const range = RANGES[key];
    if (!Number.isFinite(n)) return { ok: false, error: 'not-a-number' };
    if (range) {
      const [min, max] = range;
      if (n < min || n > max) return { ok: false, error: `out-of-range:${min}..${max}` };
    }
    stored = String(n);
  }
  db.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, stored, Date.now());
  revisions.set(db, settingsRevision(db) + 1);
  return { ok: true, key, value: parseStored(key, stored) };
}

export function clearOverride(db, key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  revisions.set(db, settingsRevision(db) + 1);
  return { ok: true, key };
}

/** 把覆盖值合并进配置对象（返回新对象，不改原配置）。 */
export function applyOverrides(cfg, overrides) {
  if (!overrides || !Object.keys(overrides).length) return cfg;
  const next = {};
  for (const [section, value] of Object.entries(cfg ?? {})) {
    next[section] = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    const path = PATHS[key];
    if (!path || path.length < 2) continue;
    let node = next;
    for (const part of path.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node[part] = { ...node[part] };
      node = node[part];
    }
    node[path[path.length - 1]] = value;
  }
  return next;
}

/** 当前生效值（给页面展示）：静态配置 + 覆盖。 */
export function effectiveView(db, cfg) {
  const overrides = getOverrides(db);
  const merged = applyOverrides(cfg, overrides);
  return Object.entries(DEFAULTS).map(([key, fallback]) => {
    const path = PATHS[key];
    let value;
    try {
      value = path.reduce((node, part) => (node == null ? undefined : node[part]), merged);
    } catch {
      value = undefined;
    }
    let out = value === undefined ? fallback : value;
    // 数组型键在页面里按逗号分隔编辑
    if (key === 'scope.sessionIds' && Array.isArray(out)) out = out.join(', ');
    return {
      key,
      value: out,
      overridden: Object.prototype.hasOwnProperty.call(overrides, key),
    };
  });
}
