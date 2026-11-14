// 插件设置页的 JSON API（只认本机）：给客户端插件读/写设置与概览
import { effectiveView, setOverride, clearOverride } from './settings.js';
import { GROUPS } from './schema.js';
import { createStatusHandler } from './status-page.js';
import { listRecentSessions } from './sessions.js';
import { ROUTE, API_BASE, apiUrl, dataDir, LOG_CLIENT_LOAD } from './const.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function count(db, sql, ...args) {
  try {
    return db.prepare(sql).get(...args)?.c ?? 0;
  } catch {
    return 0;
  }
}

export function createApiHandler(db, { cfg = {} } = {}) {
  return async (req, res) => {
    const host = String(req.headers?.host ?? '');
    const name = host.split(':')[0].toLowerCase();
    if (!(name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1')) {
      return json(res, 403, { ok: false, error: 'forbidden' });
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    // 客户端加载自检：浏览器端 apply 跑过就会打一条，用来确认前端那一半有没有起来
    if (req.method === 'POST' && url.pathname === apiUrl('/client-loaded')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* 空体也可以 */
      }
      try {
        const { appendFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = dataDir();
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          join(dir, LOG_CLIENT_LOAD),
          `${new Date().toISOString()}\t${String(body.key ?? '')}\t${String(body.id ?? '')}\t${String(body.version ?? '')}\n`,
        );
      } catch {
        /* 记不下来不影响响应 */
      }
      return json(res, 200, { ok: true });
    }

    // 最近会话（供作用域选择用；只读标题、工作区与时间）
    if (req.method === 'GET' && url.pathname === apiUrl('/sessions')) {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 60), 200);
      const sessions = listRecentSessions(limit);
      return json(res, 200, { ok: true, rows: sessions });
    }

    // 概览
    if (req.method === 'GET' && url.pathname === apiUrl('/overview')) {
      return json(res, 200, {
        ok: true,
        schema: (() => {
          try {
            return db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
          } catch {
            return 0;
          }
        })(),
        facts: count(db, "SELECT count(*) c FROM fact WHERE status='active'"),
        rules: count(db, "SELECT count(*) c FROM fact WHERE status='active' AND subtype='rule'"),
        events: count(db, "SELECT count(*) c FROM event WHERE status='active' AND event_type='observation'"),
        attention: count(db, "SELECT count(*) c FROM attention WHERE status='active'"),
        pendingVectors: count(db, 'SELECT count(*) c FROM fact_version WHERE embedding_pending=1'),
      });
    }

    // 读设置（含分组清单：页面按它渲染，不硬编码键名）
    if (req.method === 'GET' && url.pathname === apiUrl('/settings')) {
      return json(res, 200, { ok: true, groups: GROUPS, fields: effectiveView(db, cfg) });
    }

    // 写设置：{ values: { key: value } } 或 { clear: [key] }
    if (req.method === 'POST' && url.pathname === apiUrl('/settings')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'invalid-json' });
      }
      const applied = [];
      for (const [k, v] of Object.entries(body.values ?? {})) {
        const r = setOverride(db, k, v);
        if (!r.ok) return json(res, 400, { ok: false, error: `${k}:${r.error}` });
        applied.push({ key: k, value: r.value });
      }
      for (const k of body.clear ?? []) {
        clearOverride(db, String(k));
        applied.push({ key: String(k), cleared: true });
      }
      return json(res, 200, { ok: true, applied });
    }

    // 事实列表（可按关键词过滤）
    if (req.method === 'GET' && url.pathname === apiUrl('/facts')) {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 30), 200);
      const q = (url.searchParams.get('q') ?? '').trim();
      const rows = q
        ? db
            .prepare(
              `SELECT f.canonical_key AS key, f.subtype, f.scope, f.provenance_tier AS tier,
                      v.value, f.updated_at AS updatedAt
                 FROM fact f JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version
                WHERE f.status='active' AND (f.canonical_key LIKE ? OR v.value LIKE ?)
                ORDER BY f.updated_at DESC LIMIT ?`,
            )
            .all(`%${q}%`, `%${q}%`, limit)
        : db
            .prepare(
              `SELECT f.canonical_key AS key, f.subtype, f.scope, f.provenance_tier AS tier,
                      v.value, f.updated_at AS updatedAt
                 FROM fact f JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version
                WHERE f.status='active' ORDER BY f.updated_at DESC LIMIT ?`,
            )
            .all(limit);
      return json(res, 200, { ok: true, rows });
    }

    // 经历列表
    if (req.method === 'GET' && url.pathname === apiUrl('/events')) {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 30), 200);
      const rows = db
        .prepare(
          `SELECT content, speaker_name AS speaker, scope, occurred_at AS occurredAt
             FROM event WHERE status='active' AND event_type='observation'
            ORDER BY occurred_at DESC LIMIT ?`,
        )
        .all(limit);
      return json(res, 200, { ok: true, rows });
    }

    // 关注点列表
    if (req.method === 'GET' && url.pathname === apiUrl('/attention')) {
      const rows = db
        .prepare(
          `SELECT attention_id AS id, label, note, weight, hits, last_hit_at AS lastHitAt
             FROM attention WHERE status='active' ORDER BY weight DESC, created_at DESC LIMIT 200`,
        )
        .all();
      return json(res, 200, { ok: true, rows });
    }

    // 退休一个关注点
    if (req.method === 'POST' && url.pathname === apiUrl('/attention/retire')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'invalid-json' });
      }
      const id = String(body.id ?? '');
      if (!id) return json(res, 400, { ok: false, error: 'missing-id' });
      db.prepare("UPDATE attention SET status='retired' WHERE attention_id=?").run(id);
      try {
        db.prepare('DELETE FROM attention_fts WHERE attention_id=?').run(id);
        db.prepare('DELETE FROM vec_attention WHERE rowid = (SELECT rowid FROM attention WHERE attention_id=?)').run(id);
      } catch {
        /* 向量表缺失忽略 */
      }
      return json(res, 200, { ok: true, retired: id });
    }

    return json(res, 404, { ok: false, error: 'not-found' });
  };
}

/** 单一路由：/tide 与 /tide/api/* 共用一个前缀处理器。 */
export function createPluginHandler(db, { dbFile, cfg } = {}) {
  const api = createApiHandler(db, { cfg });
  const page = createStatusHandler(db, { dbFile, cfg });
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === API_BASE || url.pathname.startsWith(API_BASE + '/')) {
      return api(req, res);
    }
    if (url.pathname === ROUTE || url.pathname === ROUTE + '/') {
      return page(req, res);
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
}
