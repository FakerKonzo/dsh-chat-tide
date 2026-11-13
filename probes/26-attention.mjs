// 关注点自测：写入/命中/退休/容量
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { addAttention, listAttention, matchAttention, pruneAttention, retireAttention } from '../lib/attention.js';

const FILE = fileURLToPath(new URL('../.cache/probe-attention.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

ok(db.prepare("SELECT name FROM sqlite_master WHERE name='attention'").get()?.name === 'attention', 'attention 表存在');
ok(db.prepare("SELECT name FROM sqlite_master WHERE name='attention_fts'").get()?.name === 'attention_fts', 'attention_fts 存在');

const id1 = addAttention(db, { kind: 'topic', label: '屋顶光伏方案推进', note: '主人正在跟的项目', weight: 0.9 });
ok(!!id1, '写入关注点');
const list = listAttention(db);
ok(list.length === 1 && list[0].label === '屋顶光伏方案推进', '列表可见', JSON.stringify(list[0]));

// 命中：关键词重叠 ≥2
ok(matchAttention(db, '光伏方案那边怎么样了')?.id === id1, '文本命中（多词重叠）');
ok(matchAttention(db, '今天天气不错') === null, '无关文本不命中');

// 去重：同 label 不重复插入，只提权重
addAttention(db, { kind: 'topic', label: '屋顶光伏方案推进', weight: 0.7 });
ok(db.prepare('SELECT count(*) c FROM attention').get().c === 1, '同主题去重');

// 退休后不再命中
retireAttention(db, id1, 'test');
ok(matchAttention(db, '光伏方案那边怎么样了') === null, '退休后不命中');
ok(listAttention(db).length === 0, '退休后不在活跃列表');

// 容量裁剪
for (let i = 0; i < 10; i++) addAttention(db, { kind: 'topic', label: `主题${i}号测试`, weight: 0.1 + i * 0.01 });
const before = listAttention(db, { limit: 100 }).length;
const rep = pruneAttention(db, { maxActive: 5 });
const after = listAttention(db, { limit: 100 }).length;
ok(after <= 5, '容量裁剪生效', `${before} → ${after}，${JSON.stringify(rep)}`);

// 过期退休
const idExp = addAttention(db, { kind: 'topic', label: '过期主题测试', weight: 1, expiresAt: Date.now() - 1000 });
const rep2 = pruneAttention(db, { maxActive: 5 });
ok(!listAttention(db, { limit: 100 }).some((a) => a.id === idExp), '过期关注点被退休', JSON.stringify(rep2));

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
