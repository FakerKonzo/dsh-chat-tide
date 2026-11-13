// 探针 1：sqlite-vec 加载、vec0 增删查、更新/重建语义。
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';

const DIM = 512;
const db = new DatabaseSync(':memory:', { allowExtension: true });
console.log('node', process.version, 'sqlite', db.prepare('select sqlite_version() v').get().v);

try {
  db.loadExtension(getLoadablePath());
  console.log('sqlite-vec loaded:', getLoadablePath());
} catch (e) {
  console.log('sqlite-vec LOAD FAILED:', e.message);
  process.exit(2);
}

// node:sqlite 的 BLOB 绑定要 Uint8Array，Float32Array 直接传会被判非整数
const toBlob = (f32) => new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
const vec = (seed) => {
  const a = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) a[i] = Math.sin(seed * (i + 1)) * 0.1;
  return a;
};

db.exec(`CREATE VIRTUAL TABLE vec_x USING vec0(embedding float[${DIM}])`);
const ins = db.prepare('INSERT INTO vec_x(rowid, embedding) VALUES (?, ?)');
ins.run(BigInt(1), toBlob(vec(1)));
ins.run(BigInt(2), toBlob(vec(2)));
ins.run(BigInt(3), toBlob(vec(1.0001)));
console.log('rows:', db.prepare('select count(*) c from vec_x').get().c);

try {
  const rows = db
    .prepare('SELECT rowid, distance FROM vec_x WHERE embedding MATCH ? AND k = 2 ORDER BY distance')
    .all(toBlob(vec(1)));
  console.log('KNN ok:', JSON.stringify(rows));
} catch (e) {
  console.log('KNN FAILED:', e.message);
}

try {
  db.prepare('UPDATE vec_x SET embedding = ? WHERE rowid = ?').run(toBlob(vec(9)), BigInt(1));
  console.log('UPDATE: supported');
} catch (e) {
  console.log('UPDATE: not supported ->', e.message.slice(0, 70), '（需 DELETE+INSERT）');
}

try {
  db.prepare('DELETE FROM vec_x WHERE rowid = ?').run(BigInt(2));
  console.log('DELETE ok, rows:', db.prepare('select count(*) c from vec_x').get().c);
} catch (e) {
  console.log('DELETE FAILED:', e.message);
}

try {
  db.exec('DROP TABLE vec_x');
  db.exec(`CREATE VIRTUAL TABLE vec_x USING vec0(embedding float[${DIM}])`);
  console.log('rebuild ok');
} catch (e) {
  console.log('rebuild FAILED:', e.message);
}

// 维度不匹配时的行为（换模型才用得上）
try {
  const bad = new Float32Array(256);
  db.prepare('INSERT INTO vec_x(rowid, embedding) VALUES (?, ?)').run(BigInt(9), toBlob(bad));
  console.log('dim mismatch: accepted (危险)');
} catch (e) {
  console.log('dim mismatch: rejected ->', e.message.slice(0, 60));
}
