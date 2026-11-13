// 事实层自测：证据分级、时间仲裁、CAS 覆盖、冲突、确认、删除。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { confirmFact, deleteFact, getCandidates, getCurrentFact, writeFact } from '../lib/facts.js';
import { searchFacts } from '../lib/fts.js';

const FILE = fileURLToPath(new URL('../.cache/probe-facts.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });

const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const base = {
  userId: 'u1',
  entityId: 'u1',
  canonicalKey: 'residence',
  subtype: 'profile',
  assertedBy: 'u1',
  subjectId: 'u1',
  provenanceTier: 'human_explicit',
};

const t = (d) => Date.now() - d * 86_400_000;

// 1) 首次创建
const c1 = writeFact(db, { ...base, value: '住在杭州', evidence: '我住在杭州滨江', occurredAt: t(100), observedAt: t(100) });
ok(c1.outcome === 'created' && c1.version === 1, '首次创建', JSON.stringify(c1));
const surf = db.prepare('SELECT surface FROM fact_version WHERE fact_id=? AND version=1').get(c1.factId);
ok(surf.surface === '我住在杭州滨江', 'surface 存证据原句', JSON.stringify(surf));


// 2) 同层级、更新的时间 → 覆盖
const c2 = writeFact(db, { ...base, value: '住在上海', occurredAt: t(10), observedAt: t(10) });
ok(c2.outcome === 'replaced' && c2.factId === c1.factId && c2.version === 2, '同层级新时间覆盖', JSON.stringify(c2));
const cur = getCurrentFact(db, c1.factId);
ok(cur.value === '住在上海' && cur.version === 2, '当前值已更新');
const old = db.prepare('SELECT status FROM fact_version WHERE fact_id=? AND version=1').get(c1.factId);
ok(old.status === 'superseded', '旧版本 superseded');
ok(searchFacts(db, '杭州').length === 0 && searchFacts(db, '上海').length === 1, 'FTS 跟随覆盖');

// 3) 同层级、更早的时间 → 冲突（不得覆盖）
const c3 = writeFact(db, { ...base, value: '住在杭州', occurredAt: t(200), observedAt: t(1) });
ok(c3.outcome === 'conflicted', '更早的同层级事实进冲突', JSON.stringify(c3));
ok(getCurrentFact(db, c1.factId).value === '住在上海', '冲突不覆盖 active');
const pending = getCurrentFact(db, c3.factId);
ok(pending.status === 'pending_confirmation', '候选为 pending_confirmation');
const conf = db.prepare('SELECT * FROM fact_conflict WHERE fact_b=?').get(c3.factId);
ok(!!conf && conf.resolved === 0, '写了冲突记录');

// 4) 用户确认 → 转 active，旧的最新的让位
const cf = confirmFact(db, c3.factId, '住在杭州');
ok(cf.outcome === 'confirmed', '确认转 active', JSON.stringify(cf));
ok(getCurrentFact(db, c3.factId).status === 'active', '确认后状态 active');
ok(getCurrentFact(db, c1.factId).status === 'superseded', '被替代的事实 superseded');

// 5) 低层级不得覆盖高层级
const c4 = writeFact(db, {
  ...base,
  value: '住在北京',
  provenanceTier: 'agent_inferred',
  occurredAt: t(0),
  observedAt: t(0),
});
ok(c4.outcome === 'conflicted', 'agent_inferred 不得覆盖 human_explicit', JSON.stringify(c4));

// 6) 高层级覆盖低层级
const c5 = writeFact(db, {
  ...base,
  canonicalKey: 'job',
  value: '在写代码',
  provenanceTier: 'agent_inferred',
  occurredAt: t(50),
  observedAt: t(50),
});
const c6 = writeFact(db, {
  ...base,
  canonicalKey: 'job',
  value: '在做量化',
  provenanceTier: 'human_explicit',
  occurredAt: t(40),
  observedAt: t(40),
});
ok(c5.outcome === 'created' && c6.outcome === 'replaced', '高层级可覆盖低层级', JSON.stringify([c5.outcome, c6.outcome]));

// 7) 候选集
const cands = getCandidates(db, base);
ok(cands.length >= 2, 'fact_get 返回候选集', `n=${cands.length}`);

// 8) 删除
ok(deleteFact(db, c6.factId).outcome === 'deleted', '删除成功');
ok(getCurrentFact(db, c6.factId).status === 'deleted', '删除后状态 deleted');
ok(searchFacts(db, '量化').length === 0, '删除后 FTS 无命中');

// 9) 唯一 active 不变式（同键只应有一个 active）
const actives = db
  .prepare(`SELECT count(*) c FROM fact WHERE user_id=? AND entity_id=? AND canonical_key=? AND subtype=? AND status='active'`)
  .get('u1', 'u1', 'residence', 'profile').c;
ok(actives === 1, '同键最多一个 active', `c=${actives}`);


// 删除留审计
const del = deleteFact(db, c1.factId, { reason: 'probe:test' });
const tomb = db.prepare('SELECT target_type t, reason FROM tombstone WHERE target_id=?').get(c1.factId);
ok(del.outcome === 'deleted' && tomb?.reason === 'probe:test', '删除写 tombstone 审计', JSON.stringify(tomb));
db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
