// 手动改记忆：改值写新版本、改分类校验、删除留墓碑，归属不许动
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact, editFact, deleteFact, getCurrentFact } from '../lib/facts.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-fact-edit.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const created = writeFact(db, {
  userId: 'U1',
  entityId: 'U1',
  assertedBy: 'U1',
  subjectId: 'U1',
  canonicalKey: 'owner.city',
  subtype: 'profile',
  value: '住在杭州',
  provenanceTier: 'human_explicit',
});
const factId = created.factId;

// 1) 改值：写新版本，旧版本还在
const r1 = editFact(db, factId, { value: '住在上海' });
ok(r1.outcome === 'updated' && r1.version === 2, '改值产生新版本', JSON.stringify(r1));
ok(getCurrentFact(db, factId)?.value === '住在上海', '当前值已更新');
const versions = db.prepare('SELECT count(*) c FROM fact_version WHERE fact_id=?').get(factId).c;
ok(versions === 2, '旧版本保留为历史', String(versions));

// 2) 改名（值没变）：不产生新版本
const r2 = editFact(db, factId, { value: '住在上海' });
ok(r2.outcome === 'unchanged', '值没变时不动版本', JSON.stringify(r2));

// 3) 改分类：合法值直接落库
const r3 = editFact(db, factId, { subtype: 'preference' });
ok(r3.outcome === 'updated' && r3.changed.includes('subtype'), '改分类生效');
ok(db.prepare('SELECT subtype FROM fact WHERE fact_id=?').get(factId).subtype === 'preference', '库里分类已变');

// 4) 非法分类被拒
const r4 = editFact(db, factId, { subtype: '随便写的' });
ok(r4.outcome === 'invalid' && r4.error === 'bad-subtype', '非法分类被拒');

// 5) 空值被拒
const r5 = editFact(db, factId, { value: '   ' });
ok(r5.outcome === 'invalid' && r5.error === 'value-length', '空值被拒');

// 6) 归属不能通过这个入口改
const r6 = editFact(db, factId, { userId: 'HACKER', user_id: 'HACKER' });
ok(r6.outcome === 'unchanged', '传归属字段等于没改', JSON.stringify(r6));
ok(db.prepare('SELECT user_id FROM fact WHERE fact_id=?').get(factId).user_id === 'U1', '归属没被改掉');

// 7) 删除留墓碑和理由
const r7 = deleteFact(db, factId, { reason: 'manual-ui:说错了' });
ok(r7.outcome === 'deleted', '删除成功');
const tomb = db.prepare("SELECT reason FROM tombstone WHERE target_type='fact' AND target_id=?").get(factId);
ok(tomb?.reason === 'manual-ui:说错了', '墓碑记下了理由', JSON.stringify(tomb));
ok(editFact(db, factId, { value: 'x' }).outcome === 'not-active', '删掉的事实不能再改');

// 8) 编辑也留审计
const created2 = writeFact(db, {
  userId: 'U2',
  entityId: 'U2',
  assertedBy: 'U2',
  subjectId: 'U2',
  canonicalKey: 'owner.city',
  subtype: 'profile',
  value: '北京',
  provenanceTier: 'human_explicit',
});
editFact(db, created2.factId, { value: '南京' });
const audit = db.prepare("SELECT reason FROM tombstone WHERE target_type='fact_edit' AND target_id LIKE ?").get(created2.factId + '#%');
ok(!!audit && audit.reason.includes('value'), '改值也写了审计', JSON.stringify(audit));

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
