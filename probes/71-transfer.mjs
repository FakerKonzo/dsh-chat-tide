// 配置导入导出与整库备份
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { setOverride, getOverrides } from '../lib/settings.js';
import { writeFact } from '../lib/facts.js';
import { selectRuleFacts } from '../lib/context.js';
import { planImport, applyImport, createBackup, assertRuleInput } from '../lib/transfer.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-transfer.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 准备一点现有数据
setOverride(db, 'routing.maxWakesPerDay', '20');
setOverride(db, 'persona.mode', 'off');
writeFact(db, {
  userId: 'system',
  entityId: 'system',
  assertedBy: 'owner',
  subjectId: 'system',
  canonicalKey: 'rule.output.length',
  subtype: 'rule',
  value: '群聊一到三行',
  provenanceTier: 'source_verifiable',
});

// 1) 预览只算差异
const plan = planImport(db, {
  kind: 'tide-config',
  version: 1,
  settings: { 'routing.maxWakesPerDay': 20, 'persona.mode': 'custom', 'persona.text': '短一点', 'bogus.key': 1 },
  rules: [
    { key: 'rule.output.length', value: '群聊一到三行' },
    { key: 'rule.output.style', value: '不写小论文', appliesTo: 'group' },
    { key: 'rule.group_only', value: '仅群聊', appliesTo: 'group' },
  ],
});
ok(plan.ok, '预览成功');
ok(plan.settings.length === 2, '只列出真正变化的设置', String(plan.settings.length));
ok(plan.skippedKeys.includes('bogus.key'), '未知键被标出来');
ok(plan.rules.added.length === 2 && plan.rules.same === 1, '规矩区分新增与相同', JSON.stringify(plan.rules));
ok(plan.rules.added[0]?.appliesTo === 'group', '新增规矩保留适用范围', JSON.stringify(plan.rules.added[0]));

// 2) 应用：设置写进去、规矩新增、坏规矩被拒
const applied = applyImport(db, plan, { assertRule: assertRuleInput });
ok(applied.settings === 2, '设置写入两条', String(applied.settings));
ok(applied.rules === 2, '规矩新增两条', String(applied.rules));
ok(getOverrides(db)['persona.mode'] === 'custom', '人设模式已改');
ok(getOverrides(db)['persona.text'] === '短一点', '人设文本已写');

const badPlan = planImport(db, {
  kind: 'tide-config',
  settings: {},
  rules: [{ key: 'owner.some_key', value: '不是规矩' }, { key: 'rule.empty', value: '   ' }],
});
const badApplied = applyImport(db, badPlan, { assertRule: assertRuleInput });
ok(badApplied.rules === 0 && badApplied.ok === false, '非规矩键与空值都被拒绝', JSON.stringify(badApplied.rejected));

// 2b) 导入的规矩要按原来的适用范围落库，不能一律变成全局
const groupRule = db.prepare("SELECT applies_to a FROM fact WHERE canonical_key='rule.group_only' AND status='active'").get();
ok(groupRule?.a === 'group', '适用范围落库仍为 group', JSON.stringify(groupRule));

const existingRule = writeFact(db, {
  userId: 'TEST_OWNER',
  canonicalKey: 'rule.existing',
  subtype: 'rule',
  value: '原来的规矩',
  provenanceTier: 'human_explicit',
});
const scopeChange = planImport(db, { rules: [{ key: 'rule.existing', value: '原来的规矩', appliesTo: 'group' }] });
ok(scopeChange.rules.updated[0]?.factId === existingRule.factId, '只改范围也会预览为更新');
ok(applyImport(db, scopeChange).rules === 1, '只改范围能更新原记录');
ok(!selectRuleFacts(db, { scope: 'private' }).some((r) => r.factId === existingRule.factId), '改为仅群聊后，私聊不再收到该规矩');

const contentChange = planImport(db, { rules: [{ key: 'rule.existing', value: '更新后的规矩', appliesTo: 'private' }] });
ok(applyImport(db, contentChange).rules === 1, '同时更新正文和范围');
const updatedRule = selectRuleFacts(db).filter((r) => r.canonicalKey === 'rule.existing');
ok(updatedRule.length === 1 && updatedRule[0].factId === existingRule.factId && updatedRule[0].userId === 'TEST_OWNER'
  && updatedRule[0].tier === 'human_explicit' && updatedRule[0].value === '更新后的规矩' && updatedRule[0].appliesTo === 'private',
  '保留原规矩归属和证据等级，更新正文和范围', JSON.stringify(updatedRule));

writeFact(db, { userId: 'TEST_OTHER', canonicalKey: 'rule.existing', subtype: 'rule', value: '同名规矩', provenanceTier: 'human_explicit' });
const ambiguous = planImport(db, { rules: [{ key: 'rule.existing', value: '无法确定要改哪一条', appliesTo: 'group' }] });
ok(ambiguous.error === 'ambiguous-rule-key', '已有多条同名规矩时拒绝含糊的更新');

// 3) 版本过新要拒绝，不能瞎读
ok(planImport(db, { kind: 'tide-config', version: 99 }).ok === false, '未来版本被拒绝');
ok(planImport(db, { kind: 'other' }).ok === false, '别的文件被拒绝');

// 4) 备份：生成、校验、可读
const backup = createBackup(db, { dir: CACHE });
ok(backup.ok === true, '备份成功', backup.error ?? '');
ok(backup.size > 0, '备份文件非空', String(backup.size));
const factsInBackup = backup.facts;
ok(factsInBackup >= 1, '备份里有事实', String(factsInBackup));
if (backup.path) {
  const copy = openDatabase(backup.path, { readOnly: true });
  const rule = copy.prepare("SELECT count(*) c FROM fact WHERE status='active' AND subtype='rule'").get();
  ok(rule.c >= 1, '备份里能查到规矩', String(rule.c));
  copy.close();
  rmSync(backup.path, { force: true });
}

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
