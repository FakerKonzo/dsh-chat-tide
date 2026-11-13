// 探针 2：中文两字词召回 —— trigram vs unicode61+应用层 bigram。
import { DatabaseSync } from 'node:sqlite';

function bigram(text) {
  // 中文按 2-gram 切分并以空格连接；ASCII 连续串整体保留
  const out = [];
  const segs = text.match(/[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g) ?? [];
  for (const seg of segs) {
    if (/^[\u4e00-\u9fff]+$/.test(seg)) {
      if (seg.length === 1) out.push(seg);
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    } else {
      out.push(seg.toLowerCase());
    }
  }
  return out.join(' ');
}

const docs = [
  '主人说下周三要去杭州出差',
  '群里在聊量化回测的缺口',
  '鲸鱼娘喜欢喝奶茶但不喜欢加冰',
  '今天走了好多路，好累',
  '在吗？有人吗',
];
const queries = ['杭州', '量化', '奶茶', '走了', '在吗', '出差'];

const db = new DatabaseSync(':memory:');

// A 组：trigram（底座旧方案）
db.exec("CREATE VIRTUAL TABLE tri USING fts5(body, tokenize='trigram')");
const insTri = db.prepare('INSERT INTO tri(body) VALUES(?)');
for (const d of docs) insTri.run(d);
console.log('=== trigram ===');
for (const q of queries) {
  let n = 0;
  try {
    n = db.prepare('SELECT count(*) c FROM tri WHERE tri MATCH ?').get(q).c;
  } catch (e) {
    n = 'ERR ' + e.message.slice(0, 30);
  }
  console.log(`  ${q}: ${n}`);
}

// B 组：unicode61 + 应用层 bigram
db.exec("CREATE VIRTUAL TABLE bi USING fts5(bigram_text, tokenize='unicode61')");
const insBi = db.prepare('INSERT INTO bi(bigram_text) VALUES(?)');
for (const d of docs) insBi.run(bigram(d));
console.log('=== unicode61 + bigram ===');
console.log('  sample index text:', bigram(docs[0]));
for (const q of queries) {
  let n = 0;
  try {
    n = db.prepare('SELECT count(*) c FROM bi WHERE bi MATCH ?').get(bigram(q)).c;
  } catch (e) {
    n = 'ERR ' + e.message.slice(0, 30);
  }
  console.log(`  ${q}: ${n}`);
}

// C 组：BM25 排序是否可用
console.log('=== bm25 排序 ===');
try {
  const rows = db.prepare('SELECT rowid, bm25(bi) s, bigram_text FROM bi WHERE bi MATCH ? ORDER BY s LIMIT 3').all(bigram('奶茶'));
  console.log('  ok, rows:', rows.length, rows[0] ? rows[0].bigram_text.slice(0, 40) : '');
} catch (e) {
  console.log('  failed:', e.message);
}
