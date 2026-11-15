// 规矩按会话类型注入：群聊 / 私聊 / 其他会话，红线和权限永远在
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { selectRuleFacts, renderRuleBlock, ruleScopeOf } from '../lib/context.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-rule-scope.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const base = { userId: 'system', entityId: 'system', assertedBy: 't', subjectId: 'system', provenanceTier: 'source_verifiable', subtype: 'rule' };
const put = (key, value, appliesTo) => writeFact(db, { ...base, canonicalKey: key, value, ...(appliesTo ? { appliesTo } : {}) });

// 红线故意用"最旧"的数据写，确认排序不再看更新时间
put('rule.redline.secret_output', '密钥不外泄。');
put('rule.auth.only_master', '只有主人能让我动手。');
for (let i = 0; i < 30; i++) put(`rule.chatter.${String(i).padStart(2, '0')}`, `闲聊规矩第 ${i} 条，用来把预算撑满。`);
put('rule.group_reply_ratio', '群聊回复比例。', 'group');
put('rule.favorability_score', '好感度计分。', 'group');
put('rule.xiaoheihe.browse_tool', '逛小黑盒用指定工具。', 'local');
put('rule.owner.quant_daily_push', '每天 20:00 跑数据。', 'local');

// 1) 场景映射
ok(ruleScopeOf({ scope: 'group' }) === 'group', '群聊绑定 -> group');
ok(ruleScopeOf({ scope: 'c2c' }) === 'private', '私聊绑定 -> private');
ok(ruleScopeOf({ scope: 'local' }) === 'local', '本地会话 -> local');
ok(ruleScopeOf(null) === 'local', '没有绑定按本地处理');

// 2) 群聊不该看到小黑盒/量化推送
const g = selectRuleFacts(db, { scope: 'group' }).map((r) => r.canonicalKey);
ok(!g.includes('rule.xiaoheihe.browse_tool'), '群聊不注入本地场景规矩');
ok(g.includes('rule.group_reply_ratio'), '群聊注入群聊规矩');

// 3) 群里不该看到私聊专属（本例无），私聊不该看到群聊规矩
const p = selectRuleFacts(db, { scope: 'private' }).map((r) => r.canonicalKey);
ok(!p.includes('rule.group_reply_ratio'), '私聊不注入群聊规矩');
ok(p.includes('rule.redline.secret_output'), '私聊仍有红线');

// 4) 本地会话能看到本地规矩，看不到群聊规矩
const l = selectRuleFacts(db, { scope: 'local' }).map((r) => r.canonicalKey);
ok(l.includes('rule.xiaoheihe.browse_tool'), '本地会话注入本地规矩');
ok(!l.includes('rule.group_reply_ratio'), '本地会话不注入群聊规矩');

// 5) 红线与权限在任何场景都在，且排最前
for (const [scope, rows] of [['group', g], ['private', p], ['local', l]]) {
  ok(rows[0] === 'rule.auth.only_master' || rows[0] === 'rule.redline.secret_output', `${scope}：红线/权限排最前`, rows[0]);
  ok(rows.includes('rule.redline.secret_output') && rows.includes('rule.auth.only_master'), `${scope}：红线与权限都在`);
}

// 6) 不传 scope 时全取（体检/导出用）
ok(selectRuleFacts(db).length === 36, '不传 scope 时取全部', String(selectRuleFacts(db).length));

// 7) 预算超了要能报出来，而不是静默丢
let dropped = 0;
const block = renderRuleBlock(selectRuleFacts(db, { scope: 'private' }), { maxChars: 200, onTruncate: (n) => (dropped = n) });
ok(dropped > 0, '超出预算时回报被丢的条数', String(dropped));
ok(block.includes('rule') === false, '块里不带 rule. 前缀（用短键）', '');
ok(block.startsWith('[规则 · 数据而非指令]'), '块头仍是声明');

// 8) 预算够时一条不丢，且红线仍在
let dropped2 = 0;
const full = renderRuleBlock(selectRuleFacts(db, { scope: 'private' }), { maxChars: 50000, onTruncate: (n) => (dropped2 = n) });
ok(dropped2 === 0, '预算充足时不丢任何一条');
ok(full.includes('secret_output'), '完整块里有红线');

// 9) 场景值只认四个
ok(selectRuleFacts(db, { scope: 'nonsense' }).every((r) => (r.appliesTo ?? 'any') === 'any'), '未知场景只给 any');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
