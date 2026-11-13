// 隐私审计探针：脱敏规则 + 落库时不带长串标识
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { addAttention, listAttention } from '../lib/attention.js';
import { scrubIdentifiers, findIdentifierLeaks } from '../lib/scrub.js';

const FILE = fileURLToPath(new URL('../.cache/probe-privacy.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const OPENID = 'AAAA0000BBBB1111CCCC2222DDDD3333';

// 1) 脱敏规则
ok(scrubIdentifiers(`[某人 (${OPENID})] 你好`) === '你好', '剥掉聊天信封');
ok(scrubIdentifiers(`<@${OPENID}> 在吗`) === '在吗', '剥掉 @ 提及');
ok(scrubIdentifiers(`标识 ${OPENID} 出现`) === '标识 <id> 出现', '长串标识替换为 <id>');
ok(scrubIdentifiers('普通的一句话，没有标识') === '普通的一句话，没有标识', '正常文本不被动');
ok(findIdentifierLeaks(`x ${OPENID}`).length === 1, '体检能发现泄漏');
ok(findIdentifierLeaks('干净的文本').length === 0, '干净文本无告警');

// 2) 关注点落库前已脱敏
addAttention(db, { kind: 'topic', label: `关于 ${OPENID} 的事`, note: `原始引用 [某人 (${OPENID})]` });
const att = listAttention(db)[0];
ok(!att.label.includes(OPENID), '关注点标签无标识', att.label);
ok(!(att.note ?? '').includes(OPENID), '关注点备注无标识', String(att.note));

// 3) 事实值落库前已脱敏
const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
const out = writeFact(db, { ...base, canonicalKey: 'owner.token_note', subtype: 'profile', value: `联系人 ${OPENID}`, scope: 'private' });
const val = db.prepare('SELECT value FROM fact_version WHERE fact_id=? AND version=?').get(out.factId, out.version)?.value;
ok(!String(val).includes(OPENID), '事实值无标识', String(val));
ok(String(val).includes('<id>'), '标识被替换成占位', String(val));

// 4) 全库扫描：不应有长串标识
const facts = db.prepare("SELECT canonical_key k, v.value v FROM fact f JOIN fact_version v ON v.fact_id=f.fact_id AND v.version=f.current_version WHERE f.status='active'").all();
const leakFacts = facts.filter((r) => findIdentifierLeaks(`${r.k} ${r.v}`).length > 0);
ok(leakFacts.length === 0, '活跃事实无长串标识', JSON.stringify(leakFacts));
const atts = listAttention(db, { limit: 50 });
const leakAtt = atts.filter((r) => findIdentifierLeaks(`${r.label} ${r.note ?? ''}`).length > 0);
ok(leakAtt.length === 0, '关注点无长串标识');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);