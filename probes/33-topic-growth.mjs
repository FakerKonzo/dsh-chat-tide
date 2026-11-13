// 关注点自增长：候选记账 + 反复出现才晋升
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { addAttention, listAttention } from '../lib/attention.js';
import { recordTopicCandidate, promoteCandidates, listCandidates, cleanTopicText } from '../lib/topics.js';

const FILE = fileURLToPath(new URL('../.cache/probe-topics.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

ok(db.prepare("SELECT name FROM sqlite_master WHERE name='topic_candidate'").get()?.name === 'topic_candidate', 'topic_candidate 表存在');

// 记账
const t = '周末去钓鱼那个事后来怎么样';
ok(recordTopicCandidate(db, t) !== null, '记录一条候选');
ok(listCandidates(db)[0]?.count === 1, '首次计数 1');
recordTopicCandidate(db, t);
ok(listCandidates(db)[0]?.count === 2, '重复出现计数累加');

// 信封与提及要洗掉，不能把 openid 写进关注点
const envelope = '[小明 (AAAA0000BBBB1111CCCC2222DDDD3333)] <@EEEE4444FFFF5555AAAA6666BBBB7777> 周末去钓鱼吗 (@you)';
ok(cleanTopicText(envelope) === '周末去钓鱼吗', '清洗聊天信封与提及', JSON.stringify(cleanTopicText(envelope)));
recordTopicCandidate(db, envelope);
recordTopicCandidate(db, envelope);
const cleaned = listCandidates(db).find((x) => x.text === '周末去钓鱼吗');
ok(Boolean(cleaned) && cleaned.count === 2, '候选按清洗后的文本记账', JSON.stringify(cleaned));
ok(!listCandidates(db).some((x) => x.text.includes('AAAA0000')), '候选里不含 openid');

// 太短的文本不记
ok(recordTopicCandidate(db, '啊') === null, '过短不记');

// 只出现一次的不晋升
recordTopicCandidate(db, '只出现一次的闲聊话题');
const once = promoteCandidates(db, { minCount: 2, addAttention });
ok(once.promoted === 2, '只晋升达标的两条（含清洗后的信封话题）', JSON.stringify(once));
ok(listAttention(db, { limit: 10 }).some((a) => a.label === t), '达标话题已成为关注点');
ok(listAttention(db, { limit: 10 }).some((a) => a.label === '周末去钓鱼吗'), '清洗后的话题也晋升');
ok(!listAttention(db, { limit: 10 }).some((a) => a.label === '只出现一次的闲聊话题'), '未达标不晋升');
ok(listCandidates(db).length === 1, '已晋升的候选被清掉，只剩未达标的');

// 晋升后带权重与有效期
const att = listAttention(db, { limit: 10 }).find((a) => a.label === t);
ok(att?.weight === 0.4, '新关注点权重 0.4', String(att?.weight));

// 过期候选不晋升
recordTopicCandidate(db, '很久以前说过两次的话题', { now: Date.now() - 30 * 86400000 });
recordTopicCandidate(db, '很久以前说过两次的话题', { now: Date.now() - 30 * 86400000 });
const stale = promoteCandidates(db, { minCount: 2, maxAgeDays: 7, addAttention });
ok(stale.promoted === 0, '超期候选不晋升', JSON.stringify(stale));

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
