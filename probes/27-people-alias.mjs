// 人表 / 别名 / 纠错可用性自测
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { upsertPerson, getPerson, nicknameOf, addAlias, canonicalKeyOf } from '../lib/people.js';

const FILE = fileURLToPath(new URL('../.cache/probe-people.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 人表
upsertPerson(db, { openid: 'OPENID_A', nickname: '阿甲', relation: 'group' });
ok(getPerson(db, 'OPENID_A')?.nickname === '阿甲', '人表登记');
upsertPerson(db, { openid: 'OPENID_A', nickname: '阿甲改名' });
ok(nicknameOf(db, 'OPENID_A') === '阿甲改名', '昵称可更新');
ok(nicknameOf(db, 'MISSING', '兜底') === '兜底', '未知人用兜底');
const p1 = db.prepare("SELECT first_seen AS f FROM people WHERE openid='OPENID_A'").get();
upsertPerson(db, { openid: 'OPENID_A', nickname: '又改' });
const p2 = db.prepare("SELECT first_seen AS f FROM people WHERE openid='OPENID_A'").get();
ok(p1.f === p2.f, '首次见时间不被覆盖');

// 别名
addAlias(db, 'old.key', 'new.key');
ok(canonicalKeyOf(db, 'old.key') === 'new.key', '别名归一到规范键');
ok(canonicalKeyOf(db, 'other.key') === 'other.key', '无别名原样返回');

// 覆盖写返回旧值（供纠错审计）
const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit', canonicalKey: 'pref.x', subtype: 'preference' };
const c1 = writeFact(db, { ...base, value: '旧值', occurredAt: 1000, observedAt: 1000 });
const c2 = writeFact(db, { ...base, value: '新值', occurredAt: 2000, observedAt: 2000 });
ok(c2.outcome === 'replaced' && c2.previousValue === '旧值', '覆盖返回旧值', JSON.stringify(c2.previousValue));

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
