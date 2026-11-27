// 本机 API 加固自测：Host 解析（IPv6）、请求体上限（413）、跨站 Origin（403）、JSON Content-Type（415）
import {
  parseHostName,
  readJson,
  MAX_BODY_BYTES,
  createApiHandler,
} from '../lib/api.js';
import { createStatusHandler, createStatusResource } from '../lib/status-page.js';

let fail = 0;
const ok = (c, l, e = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`);
  if (!c) fail++;
};

// ── 假的 Node http req / res ──
function nodeReq({ method = 'GET', url = '/', host = '127.0.0.1:53322', origin, contentType, body } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (contentType !== undefined) headers['content-type'] = contentType;
  const req = { method, url, headers };
  req[Symbol.asyncIterator] = async function* () {
    if (body === undefined || body === null) return;
    const list = Buffer.isBuffer(body) || Array.isArray(body) ? (Buffer.isBuffer(body) ? [body] : body) : [body];
    for (const c of list) yield Buffer.isBuffer(c) ? c : Buffer.from(String(c));
  };
  return req;
}

function nodeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    ended: false,
    destroyed: false,
    writeHead(code, hdrs) {
      this.statusCode = code;
      this.headers = hdrs || {};
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      this.ended = true;
      if (chunk != null) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      return this;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

// 假的 web Request（只用到 method / headers.get / text）
function webReq({ method = 'POST', host = '127.0.0.1:53322', origin = null, body = '' } = {}) {
  return {
    method,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase();
        if (key === 'host') return host;
        if (key === 'origin') return origin;
        return null;
      },
    },
    text: async () => body,
  };
}

// ── A. parseHostName ──
ok(parseHostName('[::1]:53322') === '::1', 'parseHostName([::1]:53322) → ::1', parseHostName('[::1]:53322'));
ok(parseHostName('[::1]') === '::1', 'parseHostName([::1]) → ::1', parseHostName('[::1]'));
ok(parseHostName('127.0.0.1:1234') === '127.0.0.1', 'parseHostName(127.0.0.1:1234) → 127.0.0.1', parseHostName('127.0.0.1:1234'));
ok(parseHostName('localhost') === 'localhost', 'parseHostName(localhost) → localhost', parseHostName('localhost'));
ok(parseHostName('LOCALHOST:8080') === 'localhost', 'parseHostName(LOCALHOST:8080) 小写归一', parseHostName('LOCALHOST:8080'));
ok(parseHostName('::1') === '::1', 'parseHostName(裸 ::1) → ::1', parseHostName('::1'));
ok(parseHostName('') === '', 'parseHostName(空) → 空串');

// ── B. readJson 直接单测 ──
ok(MAX_BODY_BYTES === 1024 * 1024, 'MAX_BODY_BYTES = 1 MiB', String(MAX_BODY_BYTES));

const parsed = await readJson(nodeReq({ body: '{"a":1}' }));
ok(parsed && parsed.a === 1, 'readJson 正常解析 JSON');
ok((await readJson(nodeReq({ body: '' }))).constructor === Object, 'readJson 空体返回 {}');

let tooLargeErr = null;
try {
  await readJson(nodeReq({ body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x61) }));
} catch (e) {
  tooLargeErr = e;
}
ok(tooLargeErr && tooLargeErr.code === 'too-large', 'readJson 超限抛 code=too-large');

let parseErr = null;
try {
  await readJson(nodeReq({ body: 'not json' }));
} catch (e) {
  parseErr = e;
}
ok(parseErr instanceof SyntaxError, 'readJson 非法 JSON 抛 SyntaxError（交给 400）');

// ── C. createApiHandler ──
const api = createApiHandler({}, { cfg: {} });
const callApi = async (opts) => {
  const res = nodeRes();
  await api(nodeReq(opts), res);
  return res;
};

let r = await callApi({ method: 'GET', url: '/tide/api/owner', host: '[::1]:53322' });
ok(r.statusCode === 200, 'API：IPv6 Host [::1]:53322 → 200', String(r.statusCode));

r = await callApi({ method: 'GET', url: '/tide/api/owner', host: '[::1]' });
ok(r.statusCode === 200, 'API：IPv6 Host [::1] → 200', String(r.statusCode));

r = await callApi({ method: 'GET', url: '/tide/api/owner', host: 'evil.example.com' });
ok(r.statusCode === 403, 'API：外部 Host → 403', String(r.statusCode));

// 同源 POST（无 openid → 400 missing-openid，证明 Origin/Content-Type 放行）
r = await callApi({
  method: 'POST',
  url: '/tide/api/owner/adopt',
  origin: 'http://127.0.0.1:53322',
  contentType: 'application/json',
  body: '{}',
});
ok(r.statusCode === 400 && /missing-openid/.test(r.body), 'API：同源 POST 放行（→400 missing-openid）', `${r.statusCode} ${r.body}`);

// 跨站 Origin 被 403
r = await callApi({
  method: 'POST',
  url: '/tide/api/owner/adopt',
  origin: 'http://evil.example.com',
  contentType: 'application/json',
  body: '{}',
});
ok(r.statusCode === 403, 'API：跨站 Origin → 403', `${r.statusCode} ${r.body}`);

// 缺少 application/json → 415
r = await callApi({
  method: 'POST',
  url: '/tide/api/owner/adopt',
  origin: 'http://127.0.0.1:53322',
  contentType: 'text/plain',
  body: '{}',
});
ok(r.statusCode === 415, 'API：非 JSON Content-Type → 415', `${r.statusCode} ${r.body}`);

// 超限请求体 → 413（走 readJson 外层兜底，不崩）
r = await callApi({
  method: 'POST',
  url: '/tide/api/facts/edit',
  origin: 'http://127.0.0.1:53322',
  contentType: 'application/json',
  body: Buffer.alloc(MAX_BODY_BYTES + 10, 0x61),
});
ok(r.statusCode === 413, 'API：超限请求体 → 413（未崩溃）', `${r.statusCode} ${r.body}`);

// 非法 JSON → 400
r = await callApi({
  method: 'POST',
  url: '/tide/api/facts/edit',
  origin: 'http://127.0.0.1:53322',
  contentType: 'application/json',
  body: '{oops',
});
ok(r.statusCode === 400, 'API：非法 JSON → 400', `${r.statusCode} ${r.body}`);

// ── D. 状态页表单 POST（Node handler）──
const page = createStatusHandler({}, { cfg: {} });
const callPage = async (opts) => {
  const res = nodeRes();
  await page(nodeReq(opts), res);
  return res;
};

r = await callPage({ method: 'POST', host: '127.0.0.1:53322', origin: 'http://evil.example.com', body: 'action=bogus' });
ok(r.statusCode === 403, '状态页：跨站 Origin → 403', `${r.statusCode} ${r.body}`);

r = await callPage({ method: 'POST', host: '127.0.0.1:53322', origin: 'http://127.0.0.1:53322', body: 'action=bogus' });
ok(r.statusCode === 400 && /unknown action/.test(r.body), '状态页：同源表单 POST 放行（→400 unknown action）', `${r.statusCode} ${r.body}`);

r = await callPage({ method: 'POST', host: '[::1]:53322', origin: 'http://[::1]:53322', body: 'action=bogus' });
ok(r.statusCode === 400, '状态页：IPv6 同源（Host/Origin 均 [::1]）放行', `${r.statusCode} ${r.body}`);

r = await callPage({
  method: 'POST',
  host: '127.0.0.1:53322',
  origin: 'http://127.0.0.1:53322',
  body: 'x'.repeat(MAX_BODY_BYTES + 10),
});
ok(r.statusCode === 413, '状态页：超限表单 → 413', `${r.statusCode} ${r.body}`);

// ── E. 状态页 web Request 资源：跨站 403 / 同源放行 / 超限 413 ──
const resource = createStatusResource({}, { cfg: {} });

let wr = await resource(webReq({ host: '127.0.0.1:53322', origin: 'http://evil.example.com', body: 'action=bogus' }));
ok(wr.status === 403, 'Resource：跨站 Origin → 403', String(wr.status));

wr = await resource(webReq({ host: '127.0.0.1:53322', origin: 'http://127.0.0.1:53322', body: 'action=bogus' }));
ok(wr.status === 400, 'Resource：同源放行（→400 unknown action）', String(wr.status));

wr = await resource(webReq({ host: '127.0.0.1:53322', origin: 'http://127.0.0.1:53322', body: 'x'.repeat(MAX_BODY_BYTES + 10) }));
ok(wr.status === 413, 'Resource：超限表单 → 413', String(wr.status));

for (const origin of ['http://127.0.0.1:53323', 'https://127.0.0.1:53322', 'http://localhost:53322']) {
  const opts = { method: 'POST', host: '127.0.0.1:53322', origin };
  ok((await callApi({ ...opts, contentType: 'application/json', body: '{}' })).statusCode === 403, 'API 拒绝不同源 ' + origin);
  ok((await callPage({ ...opts, body: 'action=bogus' })).statusCode === 403, '表单拒绝不同源 ' + origin);
  ok((await resource(webReq({ ...opts, body: 'action=bogus' }))).status === 403, 'Resource 拒绝不同源 ' + origin);
}
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
