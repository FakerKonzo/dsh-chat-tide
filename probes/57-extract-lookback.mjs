// 抽取窗口按时间取：把前面的对话带进来当语境，代词才有落点
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { appendRawLog } from '../lib/events.js';
import { extractItems } from '../lib/extract.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-lookback.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 提示里带前文时，必须明确「只从当前消息抽取」
let seen = '';
await extractItems({
  complete: async (msgs) => {
    seen = msgs.find((m) => m.role === 'system')?.content ?? '';
    return JSON.stringify({ facts: [], events: [], attention: [] });
  },
  text: '【前文】\n[鱼] 你不是喜欢三轮电摩吗\n【当前消息】\n[鱼] 我平时都只骑内部路',
  userId: 'U1',
  subjectId: 'U1',
  speakerName: '鱼',
  hasPriorContext: true,
});
ok(seen.includes('只从【当前消息】'), '带前文时明确限定抽取范围');
ok(seen.includes('不要从【前文】里抽取'), '明确禁止从前文抽取');

// 2) 没有前文时不加这条约束（避免无谓的提示噪音）
let seen2 = '';
await extractItems({
  complete: async (msgs) => {
    seen2 = msgs.find((m) => m.role === 'system')?.content ?? '';
    return JSON.stringify({ facts: [], events: [], attention: [] });
  },
  text: '我平时都只骑内部路',
  userId: 'U1',
  subjectId: 'U1',
  speakerName: '鱼',
});
ok(!seen2.includes('只从【当前消息】'), '无前文时不加限制');

// 3) 时间窗口的语义：同会话里，边界内外的消息要能被区分出来
const NOW = Date.now();
const CK = 'qq:c2c:U1';
const put = (id, minutesAgo, text) =>
  appendRawLog(db, {
    recordId: id,
    recordType: 'message',
    adapter: 'qq',
    peerId: 'U1',
    userId: 'U1',
    conversationKey: CK,
    platform: 'qq',
    observedAt: NOW - minutesAgo * 60_000,
    payload: text,
  });
put('old', 30, '半小时前说的无关内容');
put('prior', 2, '你不是喜欢三轮电摩吗');
put('now', 0, '我平时都只骑内部路');

const rows = db
  .prepare(
    `SELECT record_id AS recordId FROM raw_log
      WHERE conversation_key = ? AND record_type = 'message' AND observed_at > ?
      ORDER BY observed_at DESC LIMIT ?`,
  )
  .all(CK, NOW - 5 * 60_000, 12)
  .map((r) => r.recordId);
ok(rows.includes('prior') && rows.includes('now'), '五分钟窗口带上前文和当前消息', rows.join(','));
ok(!rows.includes('old'), '窗口外的旧消息不进来');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
