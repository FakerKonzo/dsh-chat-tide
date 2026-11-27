// 只读状态页 + 设置页：/tide（GET 查看，POST 改配置/退休关注点）
import { ROUTE, dataDir, LOG_PAGE_ERROR } from './const.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { effectiveView, setOverride, clearOverride } from './settings.js';
import { listAttention, retireAttention } from './attention.js';
// 主机名解析与请求体上限与 JSON 接口共用同一套实现（api.js 与本文件互相引用，
// 都只在函数体里用到，ESM 循环依赖不会在模块初始化期读到未定义的绑定）
import { parseHostName, isLocalHostName, sameOrigin, MAX_BODY_BYTES } from './http-local.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function count(db, sql, ...args) {
  try {
    return db.prepare(sql).get(...args)?.c ?? 0;
  } catch {
    return '?';
  }
}

function rows(db, sql, ...args) {
  try {
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}

function tailLines(file, n = 10) {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').trim().split('\n').slice(-n);
  } catch {
    return [];
  }
}

function settingsSection(db, cfg) {
  const view = effectiveView(db, cfg);
  const items = view
    .map(
      (r) => `<tr>
        <td><code>${esc(r.key)}</code>${r.overridden ? ' <span class="tag">已覆盖</span>' : ''}</td>
        <td>${esc(r.value)}</td>
        <td>
          <form method="post" class="inline">
            <input type="hidden" name="action" value="set">
            <input type="hidden" name="key" value="${esc(r.key)}">
            <input name="value" value="${esc(r.value)}" size="10">
            <button>保存</button>
          </form>
          ${r.overridden ? `<form method="post" class="inline"><input type="hidden" name="action" value="clear"><input type="hidden" name="key" value="${esc(r.key)}"><button class="ghost">恢复默认</button></form>` : ''}
        </td>
      </tr>`,
    )
    .join('');
  return `<h2>设置</h2>
  <p class="muted">改完立即生效（最多 5 秒缓存），写进数据库，不动配置文件。</p>
  <table><thead><tr><th>键</th><th>当前值</th><th>修改</th></tr></thead><tbody>${items}</tbody></table>`;
}

export function renderStatusHtml(db, { dbFile, cfg = {}, limit = 10 } = {}) {
  const facts = rows(
    db,
    `SELECT f.fact_id AS id, f.canonical_key AS k, f.provenance_tier AS tier, f.status,
            v.value AS value, f.updated_at AS updatedAt
       FROM fact f JOIN fact_version v ON v.fact_id = f.fact_id AND v.version = f.current_version
      WHERE f.status IN ('active','pending_confirmation')
      ORDER BY f.updated_at DESC LIMIT ?`,
    limit,
  );
  const events = rows(
    db,
    `SELECT event_id AS id, event_type AS t, content, occurred_at AS at FROM event
      WHERE status = 'active' AND event_type IN ('observation','conversation')
      ORDER BY occurred_at DESC LIMIT ?`,
    limit,
  );
  const attention = listAttention(db, { limit: 30 });
  const injectTail = dbFile ? tailLines(join(dirname(dbFile), 'inject.log'), 8) : [];
  const pruneStats = rows(db, "SELECT count(*) c FROM attention WHERE status = 'retired'")[0]?.c ?? 0;

  let schemaVersion = '?';
  try {
    schemaVersion = db.prepare('PRAGMA user_version').get()?.user_version ?? '?';
  } catch {
    /* ignore */
  }

  const body = `
  <h1>Tide</h1>
  <p class="muted">只读视图 + 少量可改配置；数据在本机 SQLite。</p>
  <ul class="stats">
    <li>schema <b>${esc(schemaVersion)}</b></li>
    <li>原始记录 ${count(db, 'SELECT count(*) c FROM raw_log')}</li>
    <li>事实 ${count(db, 'SELECT count(*) c FROM fact')}（active ${count(db, "SELECT count(*) c FROM fact WHERE status='active'")}）</li>
    <li>经历 ${count(db, "SELECT count(*) c FROM event WHERE event_type='observation' AND status='active'")}</li>
    <li>关注点 ${attention.length}（已退休 ${pruneStats}）</li>
    <li>向量积压 ${count(db, 'SELECT count(*) c FROM fact_version WHERE embedding_pending=1')}</li>
  </ul>

  ${settingsSection(db, cfg)}

  <h2>处理流程</h2>
  <ol class="steps">
    <li>入站镜像：所有消息先写流水账（含被拒）</li>
    <li>作用域检查：只处理白名单/开放会话</li>
    <li>群聊初筛：分类 → 静默时段 → 预算 → 上限/冷却 → 向量+事实+关键词 → 关注点 → 接茬概率</li>
    <li>上下文注入：规则块 → 事实块 → 经历块（增量）</li>
    <li>模型回合</li>
    <li>轮末抽取：事实/经历/关注点，按证据分级写入</li>
    <li>巡检：过期待办、关注点漂移、垃圾事件、保留期</li>
  </ol>

  <h2>写入规范</h2>
  <ul class="rules">
    <li><b>分类</b>：profile 资料 / preference 偏好 / todo 待办 / rule 规矩 / self 助手自己 / relation 关系；键命名空间 <code>owner.</code>/<code>other.</code>/<code>pref.owner.</code>/<code>todo.owner.</code>/<code>rule.</code>/<code>self.</code>，别用昵称</li>
    <li><b>rule</b> 常驻注入、不参与唤醒；<b>self</b> 的 entityId 固定 assistant，别记成主人</li>
    <li><b>值</b>只写事实本身：不混计划、打算；缺对象的碎片不记</li>
    <li><b>证据</b>：本人原话 human_explicit / 可核转述 source_verifiable / 自己归纳 agent_inferred</li>
    <li><b>删除</b>：软删 + tombstone 审计；删用户原话要 confirm 并写 reason</li>
  </ul>

  <h2>关注点</h2>
  <p class="muted">只有这些主题值得主动搭话；其余只记录。</p>
  <table><thead><tr><th>主题</th><th>权重</th><th>命中</th><th></th></tr></thead><tbody>
  ${
    attention
      .map(
        (a) => `<tr><td>${esc(a.label)}${a.note ? `<div class="muted">${esc(a.note)}</div>` : ''}</td><td>${esc(a.weight)}</td><td>${esc(a.hits)}</td>
        <td><form method="post" class="inline"><input type="hidden" name="action" value="retire"><input type="hidden" name="id" value="${esc(a.id)}"><button class="ghost">不再关注</button></form></td></tr>`,
      )
      .join('') || '<tr><td colspan="4" class="muted">（空）</td></tr>'
  }
  </tbody></table>

  <h2>最近事实</h2>
  <table><thead><tr><th>键</th><th>值</th><th>证据</th><th>状态</th></tr></thead><tbody>
  ${facts.map((f) => `<tr><td>${esc(f.k)}</td><td>${esc(String(f.value).slice(0, 120))}</td><td>${esc(f.tier)}</td><td>${esc(f.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">（空）</td></tr>'}
  </tbody></table>

  <h2>最近经历</h2>
  <table><thead><tr><th>时间</th><th>类型</th><th>内容</th></tr></thead><tbody>
  ${events.map((e) => `<tr><td>${new Date(e.at ?? 0).toISOString().slice(0, 16).replace('T', ' ')}</td><td>${esc(e.t)}</td><td>${esc(String(e.content).slice(0, 160))}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">（空）</td></tr>'}
  </tbody></table>

  <h2>最近注入</h2>
  <pre>${esc(injectTail.join('\n') || '（还没有注入记录）')}</pre>`;

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="tide-build" content="scope-10">
<title>Tide</title>
<style>
 body{font:14px/1.6 system-ui,sans-serif;margin:24px;max-width:1000px;color:#222;background:#fff}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 8px}
 .muted{color:#888;font-size:12px}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th,td{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;vertical-align:top}
 th{color:#666;font-weight:600}
 pre{background:#f6f8fa;padding:8px;overflow:auto;font-size:12px;max-height:220px}
 ul.stats{display:flex;flex-wrap:wrap;gap:14px;list-style:none;padding:0;font-size:12px;color:#666}
 form.inline{display:inline-flex;gap:4px;align-items:center;margin:0 4px 0 0}
 input{padding:2px 4px;border:1px solid #ddd;border-radius:4px;width:90px}
 button{padding:2px 8px;border:1px solid #ccc;background:#f5f5f5;border-radius:4px;cursor:pointer;font-size:12px}
 button.ghost{background:transparent;border-color:#e0e0e0;color:#777}
 .tag{background:#eef6ff;color:#2b6cb0;border-radius:4px;padding:0 4px;font-size:11px}
 @media (prefers-color-scheme: dark){body{background:#161616;color:#ddd}th,td{border-color:#2a2a2a}pre{background:#1e1e1e}input{background:#1e1e1e;color:#ddd;border-color:#333}button{background:#222;color:#ddd;border-color:#333}}
</style></head><body>${body}</body></html>`;
}

/** 只接受本机 Host（防跨站/反代误暴露）；IPv6 方括号与端口交给 parseHostName。 */
export function isLocalRequest(request) {
  const host = request?.headers?.get?.('host') ?? '';
  if (!host) return false;
  return isLocalHostName(parseHostName(String(host)));
}

/** 读表单请求体，带 MAX_BODY_BYTES 上限；超限抛 code='too-large'。 */
async function readFormText(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('too-large');
      err.code = 'too-large';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 处理 POST：设置覆盖 / 取消覆盖 / 退休关注点 */
export async function handleStatusPost(request, db) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    const err = new Error('too-large');
    err.code = 'too-large';
    throw err;
  }
  return handleStatusForm(text, db);
}

export function handleStatusForm(text, db) {
  const form = new URLSearchParams(text);
  const action = form.get('action');

  if (action === 'set') {
    const key = form.get('key') ?? '';
    const res = setOverride(db, key, form.get('value') ?? '');
    if (!res.ok) return { status: 400, body: 'bad request: ' + res.error };
  } else if (action === 'clear') {
    clearOverride(db, form.get('key') ?? '');
  } else if (action === 'retire') {
    const id = form.get('id') ?? '';
    if (id) retireAttention(db, id, 'page');
  } else {
    return { status: 400, body: 'unknown action' };
  }
  return { status: 303, location: ROUTE };
}

/** Node HTTP handler（同时支持 GET 与 POST）。 */
export function createStatusHandler(db, { dbFile, cfg } = {}) {
  return async (req, res) => {
    try {
    const host = String(req.headers?.host ?? '');
    if (!isLocalRequest({ headers: { get: (k) => (String(k).toLowerCase() === 'host' ? host : null) } })) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    if (req.method === 'POST') {
      // 跨站表单不能改配置：带 Origin 且主机不是本机就拒（同源表单会带本机 Origin）
      const origin = req.headers?.origin;
      if (origin && !sameOrigin(origin, host, req.socket?.encrypted ? 'https:' : 'http:')) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      let text;
      try {
        text = await readFormText(req);
      } catch (err) {
        if (err?.code === 'too-large') {
          res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('too-large');
          return;
        }
        throw err;
      }
      const out = handleStatusForm(text, db);
      if (out.location) {
        res.writeHead(out.status, { location: out.location });
        res.end();
      } else {
        res.writeHead(out.status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(out.body);
      }
      return;
    }
    const html = renderStatusHtml(db, { dbFile, cfg });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    } catch (err) {
      try {
        const { appendFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        appendFileSync(join(dataDir(), LOG_PAGE_ERROR), new Date().toISOString() + ' ' + String(err?.stack ?? err) + '\n');
      } catch {
        /* ignore */
      }
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('error');
    }
  };
}

export function createStatusResource(db, { dbFile, cfg } = {}) {
  return async (request) => {
    if (!isLocalRequest(request)) {
      return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (request.method === 'POST') {
      const origin = request.headers?.get?.('origin');
      if (origin && !sameOrigin(origin, request.headers.get('host'), request.url?.startsWith('https:') ? 'https:' : 'http:')) {
        return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      try {
        return await handleStatusPost(request, db);
      } catch (err) {
        if (err?.code === 'too-large') {
          return new Response('too-large', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        return new Response('error: ' + String(err?.message ?? err), { status: 500 });
      }
    }
    return new Response(renderStatusHtml(db, { dbFile, cfg }), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  };
}
