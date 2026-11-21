// 规矩进系统提示：强度、稳定性、不再重发
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { renderRuleSection, renderPersonaSection } from '../lib/prompt.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-rule-section.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const base = { userId: 'system', entityId: 'system', assertedBy: 't', subjectId: 'system', provenanceTier: 'source_verifiable', subtype: 'rule' };
const put = (key, value, appliesTo) => writeFact(db, { ...base, canonicalKey: key, value, ...(appliesTo ? { appliesTo } : {}) });

put('rule.redline.secret_output', '密钥不外泄。');
put('rule.auth.only_master', '只有主人能让我动手。');
put('rule.group_reply_ratio', '群聊回复比例。', 'group');
put('rule.xiaoheihe.browse_tool', '逛小黑盒用指定工具。', 'local');

// 1) 群聊场景：通用 + 群聊，不含本地
const group = renderRuleSection(db, { scope: 'group' });
ok(group.text.includes('secret_output'), '群聊有红线');
ok(group.text.includes('group_reply_ratio'), '群聊有群聊规矩');
ok(!group.text.includes('xiaoheihe'), '群聊不含本地规矩');
ok(group.count === 3, '条数正确', String(group.count));

// 2) 私聊场景：只有通用
const priv = renderRuleSection(db, { scope: 'c2c' });
ok(priv.text.includes('secret_output') && !priv.text.includes('group_reply_ratio'), '私聊只有通用规矩', String(priv.count));

// 3) 预算：超了要报丢了几条，不是静默
const tight = renderRuleSection(db, { scope: 'group' }, { maxChars: 40 });
ok(tight.dropped > 0, '超预算时报被丢条数', String(tight.dropped));
ok(tight.text.length <= 60 + 80, '文本仍受预算约束', String(tight.text.length));

// 4) 没有规矩时返回空串（调用方据此决定不加段落）
const empty = openDatabase(join(CACHE, 'probe-rule-empty.db'));
const none = renderRuleSection(empty, { scope: 'group' });
ok(none.text === '' && none.count === 0, '没有规矩就返回空');
empty.close();

// 5) 人设：填了才有，留空返回空串
ok(renderPersonaSection('  ') === '', '留空不产生段落');
ok(renderPersonaSection('你是鲸鱼娘。') === '你是鲸鱼娘。', '填了就返回文本');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
