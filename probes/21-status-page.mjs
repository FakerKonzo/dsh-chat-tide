// 状态页/设置页自测：渲染、本机校验、POST 改配置、退休关注点
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { appendEvent } from '../lib/events.js';
import { addAttention, listAttention } from '../lib/attention.js';
import { effectiveView } from '../lib/settings.js';
import { createStatusResource, isLocalRequest, renderStatusHtml } from '../lib/status-page.js';

const FILE = fileURLToPath(new URL('../.cache/probe-status.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
writeFact(db, { ...base, canonicalKey: 'city', value: '杭州' });
appendEvent(db, { eventId: 'e1', eventType: 'observation', content: '今天吃了三个饼', occurredAt: Date.now() });
const attId = addAttention(db, { kind: 'topic', label: '屋顶光伏方案', weight: 0.8 });

const cfg = { routing: { ambientReplyProbability: 0.1, high: 0.55, low: 0.42, margin: 0.02, l2Threshold: 0.45, exemplarThreshold: 0.5, budget: 1000 }, attention: { enabled: true, maxActive: 80, ttlDays: 30 }, context: { maxChars: 1200 }, features: { contextInject: true } };

const html = renderStatusHtml(db, { dbFile: FILE, cfg });
ok(html.includes('chat-memory'), '页面标题');
ok(html.includes('杭州') && html.includes('今天吃了三个饼'), '展示事实与经历');
ok(html.includes('设置') && html.includes('routing.ambientReplyProbability'), '有设置区');
ok(html.includes('屋顶光伏方案') && html.includes('不再关注'), '有关注点列表和退休按钮');
ok(!html.includes('<script'), '不引入脚本');

const res = createStatusResource(db, { dbFile: FILE, cfg });
const mkReq = (host, opts = {}) => ({
  headers: { get: (k) => (k.toLowerCase() === 'host' ? host : null) },
  method: opts.method ?? 'GET',
  text: async () => opts.body ?? '',
});

ok(isLocalRequest(mkReq('127.0.0.1:55535')) === true, '本机 Host 放行');
ok(isLocalRequest(mkReq('evil.example.com')) === false, '外部 Host 拒绝');
ok((await res(mkReq('127.0.0.1:55535'))).status === 200, '本机 GET 200');
ok((await res(mkReq('evil.example.com'))).status === 403, '外部 GET 403');

// POST 设置
const post = (body, host = '127.0.0.1:55535') => res(mkReq(host, { method: 'POST', body }));

let r = await post('action=set&key=routing.ambientReplyProbability&value=0.3');
ok(r.status === 303, '保存设置返回 303');
let view = Object.fromEntries(effectiveView(db, cfg).map((x) => [x.key, x]));
ok(view['routing.ambientReplyProbability'].value === 0.3 && view['routing.ambientReplyProbability'].overridden === true, '覆盖生效 0.3');

// 越界与未知键
ok((await post('action=set&key=routing.ambientReplyProbability&value=9')).status === 400, '越界值被拒 400');
ok((await post('action=set&key=evil.key&value=1')).status === 400, '未知键被拒 400');
ok((await post('action=retire&id=')).status === 303, '空 id 退休是 no-op 303');

// 恢复默认
ok((await post('action=clear&key=routing.ambientReplyProbability')).status === 303, '恢复默认 303');
view = Object.fromEntries(effectiveView(db, cfg).map((x) => [x.key, x]));
ok(view['routing.ambientReplyProbability'].value === 0.1 && view['routing.ambientReplyProbability'].overridden === false, '恢复后回到 0.1');

// 退休关注点
ok(listAttention(db).length === 1, '退休前有 1 条关注点');
ok((await post(`action=retire&id=${encodeURIComponent(attId)}`)).status === 303, '退休请求 303');
ok(listAttention(db).length === 0, '退休后列表为空');

// 外部 Host 不能写
ok((await post('action=set&key=routing.high&value=0.5', 'evil.example.com')).status === 403, '外部 POST 403');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
