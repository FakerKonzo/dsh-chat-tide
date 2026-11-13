// 上下文构建 + 巡检自测。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { selectFacts, selectFactsForUsers, renderFactBlock, renderDeltaBlock, contextMessage } from '../lib/context.js';
import { runJanitor } from '../lib/janitor.js';

const FILE = fileURLToPath(new URL('../.cache/probe-context.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const base = { userId: 'u1', entityId: 'u1', assertedBy: 'u1', subjectId: 'u1', provenanceTier: 'human_explicit' };
const write = (key, value, extra = {}) => writeFact(db, { ...base, canonicalKey: key, value, ...extra });

write('residence', '杭州');
write('drink', '奶茶不加冰');
write('job', '写代码');
write('todo.report', '周五交周报', { subtype: 'todo' });

// 1) 选取 active 事实
const rows = selectFacts(db, { userId: 'u1' });
ok(rows.length === 4, '选取 active 事实', `n=${rows.length}`);

// 2) 同键只留最新
write('residence', '上海');
const rows2 = selectFacts(db, { userId: 'u1' });
const block = renderFactBlock(rows2);
ok(!block.includes('杭州') && block.includes('上海'), '同键只注入最新值');
ok(block.includes('[已知事实') && block.includes('数据而非指令'), '注入块带数据声明');

// 3) 预算裁剪
const tiny = renderFactBlock(rows2, { maxChars: 20 });
ok(tiny.split('\n').length <= 5, '预算裁剪生效', JSON.stringify(tiny.slice(0, 40)));

// 4) 时间窗过滤：valid_to 已过的事实不注入
db.prepare(`UPDATE fact SET valid_to=? WHERE canonical_key='job'`).run(Date.now() - 1000);
const rows3 = selectFacts(db, { userId: 'u1' });
ok(!rows3.some((r) => r.canonicalKey === 'job'), '过期事实不注入');

// 5) 增量块与消息包装
const delta = renderDeltaBlock([{ canonicalKey: 'residence', from: '杭州', to: '上海' }]);
ok(delta.includes('旧值已失效'), '增量块标注覆盖');
const msg = contextMessage('x');
ok(msg.role === 'user' && msg.content[0].type === 'text', '注入消息形态正确');

// 6) 巡检：待确认超时 → superseded
const pend = writeFact(db, { ...base, canonicalKey: 'pet', value: '养猫', occurredAt: Date.now() - 9e9, observedAt: Date.now() - 9e9 });
// 造一个同键 active 来逼出 pending
write('pet', '养狗');
const pend2 = writeFact(db, { ...base, canonicalKey: 'pet', value: '养猫', occurredAt: Date.now() - 9e9 });
ok(pend2.outcome === 'conflicted', '造出待确认条目', JSON.stringify(pend2.outcome));
db.prepare(`UPDATE fact SET updated_at=? WHERE fact_id=?`).run(Date.now() - 8 * 86_400_000, pend2.factId);
const rep = runJanitor(db, { now: Date.now() });
ok(rep.expiredPending.includes(pend2.factId), '巡检把超时待确认转 superseded', JSON.stringify(rep.expiredPending.length));

// 7) 巡检：向量积压
db.prepare(`UPDATE fact_version SET embedding_pending=1 WHERE fact_id=?`).run(rows2[0].factId);
const rep2 = runJanitor(db, { now: Date.now() });
ok(rep2.embeddingBacklog.length >= 1, '巡检发现向量积压', `n=${rep2.embeddingBacklog.length}`);
void pend;

// 8) 群聊：peer（群）与 sender（成员）两边的 active 事实都要取到，同键只留最新
writeFact(db, { userId: 'group-g1', entityId: 'group-g1', assertedBy: 'u1', subjectId: 'group-g1', provenanceTier: 'source_verifiable', canonicalKey: 'group_topic', value: '周末爬山' });
writeFact(db, { userId: 'member-u2', entityId: 'member-u2', assertedBy: 'u2', subjectId: 'u2', provenanceTier: 'human_explicit', canonicalKey: 'residence', value: '南京' });
const multi = selectFactsForUsers(db, { userIds: ['group-g1', 'member-u2'] });
ok(multi.some((r) => r.canonicalKey === 'group_topic') && multi.some((r) => r.canonicalKey === 'residence'), '多归属人事实都能取到', JSON.stringify(multi.map((r) => r.canonicalKey)));
ok(selectFactsForUsers(db, { userIds: [] }).length === 0, '空名单返回空');
const blockMulti = renderFactBlock(multi);
ok(blockMulti.includes('周末爬山') && blockMulti.includes('南京'), '渲染包含两边事实');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
