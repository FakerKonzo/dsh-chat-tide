// 注入消息形状回归测试（防止再次出现 reading 'kind' 崩溃）
import { plainContextMessage, isValidUserMessageShape } from '../lib/context.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const m = plainContextMessage('[已知事实]\n- city: 杭州');
ok(isValidUserMessageShape(m), '兜底消息形状合法', JSON.stringify(Object.keys(m)));
ok(m.role === 'user', 'role=user');
ok(typeof m.id === 'string' && m.id.length > 0, '带 id');
ok(m.source?.kind === 'user', 'source.kind=user（本宿主合法值）', JSON.stringify(m.source));
ok(m.content[0].type === 'text' && m.content[0].text.includes('杭州'), '正文正确');

// 复现旧 bug：缺 source 的对象必须被判为不合法
const broken = { id: 'x', role: 'user', content: [{ type: 'text', text: 'a' }] };
ok(!isValidUserMessageShape(broken), '缺 source.kind 被识别为非法');

ok(!isValidUserMessageShape({ role: 'assistant', id: 'x', source: { kind: 'plugin' }, content: [] }), '非 user 判非法');
ok(!isValidUserMessageShape(null), 'null 判非法');

// 规则不进普通事实选择，避免注入时规则和事实各出现一次
const { openDatabase } = await import('../lib/db.js');
const { writeFact } = await import('../lib/facts.js');
const { selectFactsForUsers, selectRuleFacts } = await import('../lib/context.js');
const { rmSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const TDB = fileURLToPath(new URL('../.cache/probe-ctx-message.db', import.meta.url));
rmSync(TDB, { force: true });
const tdb = openDatabase(TDB);
const base = { userId: 'u9', entityId: 'u9', assertedBy: 'u9', subjectId: 'u9', provenanceTier: 'human_explicit' };
writeFact(tdb, { ...base, canonicalKey: 'city', value: '杭州', subtype: 'profile' });
writeFact(tdb, { ...base, canonicalKey: 'rule.test', value: '早睡早起', subtype: 'rule' });
const picked = selectFactsForUsers(tdb, { userIds: ['u9'], limit: 10 });
const rulePicked = selectRuleFacts(tdb, { limit: 10 });
ok(!picked.some((x) => x.subtype === 'rule'), '普通事实选择排除规则');
ok(rulePicked.length === 1, '规则单独选出', String(rulePicked.length));

const { renderEventBlock } = await import('../lib/context.js');
const eb = renderEventBlock([{ content: '今天吃了三个饼', speakerName: '小明', occurredAt: Date.now() }]);
ok(eb.includes('[小明]'), '经历带发言人', eb.slice(0, 40));
const eb2 = renderEventBlock([{ content: '今天吃了三个饼', occurredAt: Date.now() }]);
ok(!eb2.includes('[]') && eb2.includes('三个饼'), '无发言人时不出现空标签');
tdb.close();

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
