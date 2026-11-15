// 关注点标签规整：去主语与指令腔，但不截断、不过度压成名词
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { addAttention, listAttention, normalizeAttentionLabel } from '../lib/attention.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 纯函数
ok(normalizeAttentionLabel('主人固定晚上逛小黑盒社区，留意可发言的帖子') === '晚上逛小黑盒社区', '去掉主语与指令从句');
ok(normalizeAttentionLabel('记得提醒我量化仓位风险') === '量化仓位风险', '剥掉开头指令动词');
ok(normalizeAttentionLabel('留意一下原神的低配满星攻略') === '原神的低配满星攻略', '剥掉“留意一下”');
ok(normalizeAttentionLabel('git 凭据与推送问题') === 'git 凭据与推送问题', '普通标签不动');
ok(normalizeAttentionLabel('主人对量化项目仓位风险的看法') === '量化项目仓位风险的看法', '保留描述，不压成纯名词');

const long = '关于那个从去年秋天一直拖到现在还没有定下来的汽车线束专利方案到底要不要补柔性两个字的讨论';
ok(normalizeAttentionLabel(long) === long, '长标签不截断');
ok(normalizeAttentionLabel('') === '', '空标签保持空');

// 2) 落库时自动规整
const FILE = fileURLToPath(new URL('../.cache/probe-attention-label.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
addAttention(db, { kind: 'topic', label: '主人固定晚上逛小黑盒社区，留意可发言的帖子', weight: 0.3 });
const saved = listAttention(db, { limit: 5 })[0];
ok(saved?.label === '晚上逛小黑盒社区', '写入时已规整', saved?.label);

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
