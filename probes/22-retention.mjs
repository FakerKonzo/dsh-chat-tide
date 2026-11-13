// 载荷保留策略自测（设计 §13.1：过期只脱敏内容，保留审计信封）
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { appendRawLog } from '../lib/events.js';
import { runJanitor } from '../lib/janitor.js';

const FILE = fileURLToPath(new URL('../.cache/probe-retention.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const DAY = 86_400_000;
const now = Date.now();
appendRawLog(db, { recordId: 'old1', recordType: 'message', adapter: 'qq', peerId: 'p', conversationKey: 'qq:p', payload: '很久以前的私密内容', observedAt: now - 30 * DAY });
appendRawLog(db, { recordId: 'old2', recordType: 'message', adapter: 'qq', peerId: 'p', conversationKey: 'qq:p', payload: '也很久以前', observedAt: now - 20 * DAY });
appendRawLog(db, { recordId: 'new1', recordType: 'message', adapter: 'qq', peerId: 'p', conversationKey: 'qq:p', payload: '今天刚说的', observedAt: now - 1 * DAY });

// 默认不清理
const rep0 = runJanitor(db, { now });
ok(rep0.retentionRedacted === 0, '默认（rawLogDays=0）不清理');
ok(db.prepare("SELECT count(*) c FROM raw_log WHERE payload_status='available'").get().c === 3, '默认三条都还在');

// 保留 7 天：只有旧的两条被脱敏
const rep = runJanitor(db, { now, rawLogDays: 7 });
ok(rep.retentionRedacted === 2, '过期两条被脱敏', JSON.stringify(rep.retentionRedacted));
const old1 = db.prepare("SELECT payload, payload_status FROM raw_log WHERE record_id='old1'").get();
ok(old1.payload === null && old1.payload_status === 'redacted', '载荷清空 + 状态 redacted', JSON.stringify(old1));
const new1 = db.prepare("SELECT payload, payload_status FROM raw_log WHERE record_id='new1'").get();
ok(new1.payload === '今天刚说的' && new1.payload_status === 'available', '未过期不处理');
ok(db.prepare("SELECT record_id FROM raw_log WHERE record_id='old1'").get()?.record_id === 'old1', '审计信封（record_id）保留');
ok(rep.actions.some((a) => a.kind === 'redact-payload'), '动作清单记录脱敏');

// 幂等：再跑一次不再处理
const rep2 = runJanitor(db, { now, rawLogDays: 7 });
ok(rep2.retentionRedacted === 0, '已脱敏的不会重复处理');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
