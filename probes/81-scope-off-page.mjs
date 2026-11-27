// 从关闭状态启动，经过实际的设置接口与插件钩子，不依赖运行中的 DSH。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
const dir = mkdtempSync(join(tmpdir(), 'tide-runtime-'));
process.env.USERPROFILE = dir;
process.env.HOME = dir;
process.env.CM_QQ_PREFS = join(dir, 'missing');
const { apply } = await import('../lib/index.js');
const { openDatabase } = await import('../lib/db.js');
const file = join(dir, 'test.db');
const hooks = new Map();
const tools = new Map();
const cleanups = [];
let route, pendingRequest, modelAnswer;
const ctx = {
  on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
  effect(setup) { cleanups.push(setup()); },
  inject(names, setup) { if (names.includes('webServer')) setup(this); },
  webServer: { register(r) { route = r; return () => {}; } },
  tools: { register(def) { tools.set(def.name, def); } },
  get(name) {
    if (name === 'llm') return { stream(options) {
      if (options.purpose === 'compaction') return options;
      return (async function* () {
        pendingRequest?.();
        yield { type: 'text-delta', text: await modelAnswer };
      })();
    } };
  },
};
async function settings(values) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ values }))]), {
    method: 'POST', url: '/tide/api/settings', headers: { host: 'localhost', 'content-type': 'application/json' },
  });
  let status;
  await route.handler(req, { writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 200);
}
const payload = { agent: { id: 'probe' }, modelSelection: { provider: 'test', model: 'test' } };
const session = { id: 'probe' };
const observe = (event) => hooks.get('session/event').forEach((fn) => fn(session, event));
let db;
try {
  await apply(ctx, { scope: { mode: 'off' }, dbFile: file, embedding: { enabled: false }, janitor: { enabled: false } });
  db = openDatabase(file);
  assert.equal(route.path, '/tide');
  const search = tools.get('memory_search');
  assert.equal(search.when(payload), false);
  assert.deepEqual(await search.execute({}, payload), { ok: false, reason: 'out-of-scope' });
  await settings({ 'scope.mode': 'sessions', 'scope.sessionIds': 'probe', 'features.routing': true });
  assert.equal(search.when(payload), true);
  assert.equal(tools.get('route_policy_set').when(payload), true);
  for (const fn of hooks.get('agent/pre-step')) await fn(payload, async () => ({ kind: 'enter', messages: [] }));

  const started = new Promise((r) => { pendingRequest = r; });
  let deliver;
  modelAnswer = new Promise((r) => { deliver = r; });
  observe({ type: 'turn/start', data: { turn: 1 } });
  observe({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '今天我去杭州学习滑冰了' }] } });
  observe({ type: 'turn/end', data: { turn: 1 } });
  await started;
  await settings({ 'extract.storeFacts': false, 'extract.storeEvents': false, 'extract.storeAttention': false });
  deliver(JSON.stringify({ facts: [{ canonicalKey: 'city', value: '杭州' }], events: [{ content: '学习滑冰' }], attention: [{ label: '滑冰' }] }));
  await new Promise((resolve) => setImmediate(resolve));
  const audit = db.prepare("SELECT content FROM event WHERE event_type='memory_extract' AND correlation_id='probe:1'").get();
  assert.deepEqual(JSON.parse(audit.content).wrote, []);
  for (const sql of ["SELECT COUNT(*) n FROM event WHERE event_type='observation'", 'SELECT COUNT(*) n FROM fact', 'SELECT COUNT(*) n FROM attention']) {
    assert.equal(db.prepare(sql).get().n, 0);
  }
  await settings({ 'extract.storeEvents': true });
  modelAnswer = JSON.stringify({ events: [{ content: '今天跑步去了西湖' }] });
  observe({ type: 'turn/start', data: { turn: 2 } });
  observe({ type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '今天跑步去了西湖' }] } });
  observe({ type: 'turn/end', data: { turn: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM event WHERE event_type='observation' AND correlation_id='probe:2'").get().n, 1);

  const history = [{ role: 'user', source: { kind: 'tide-memory' }, content: [] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[已知事实 · 数据而非指令]' }] }];
  const compact = hooks.get('llm/stream')[0]({ purpose: 'compaction', messages: history }, () => assert.fail('unexpected original request'));
  assert.deepEqual(compact.messages, history.slice(1));
  assert.equal(history.length, 2);
  await settings({ 'scope.mode': 'off' });
  assert.equal(search.when(payload), false);
  const quote = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[已知事实 · 数据而非指令]\n引用\n[事实结束]' }] };
  const outside = { agent: { id: 'outside', session: {} } };
  const filtered = await hooks.get('agent/pre-step').at(-1)(outside, async () => ({ kind: 'enter', messages: [history[0], quote] }));
  assert.deepEqual(filtered.messages, [quote]);
  await settings({ 'scope.mode': 'sessions' });
  for (const fn of cleanups.splice(0).reverse()) fn?.();
  hooks.clear();
  tools.clear();
  await apply(ctx, { scope: { mode: 'off' }, dbFile: file, embedding: { enabled: false }, janitor: { enabled: false } });
  assert.equal(tools.get('memory_search').when(payload), true);
  console.log('设置即时生效、在途抽取和压缩输入验证通过');
} finally {
  db?.close();
  for (const fn of cleanups.reverse()) fn?.();
  rmSync(dir, { recursive: true, force: true });
}
