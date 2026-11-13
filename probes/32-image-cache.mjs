// 图片缓存自测：同一张图只存一条、语义可覆盖、提示可渲染
import { rmSync, writeFileSync as writeText } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { extractImagePath, sha1OfFile, getCachedImage, putCachedImage, renderImageHint } from '../lib/images.js';

const DIR = fileURLToPath(new URL('../.cache/', import.meta.url));
const FILE = fileURLToPath(new URL('../.cache/probe-images.db', import.meta.url));
const IMG = fileURLToPath(new URL('../.cache/probe-image.png', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
rmSync(IMG, { force: true });
writeText(IMG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]));

const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

ok(db.prepare("SELECT name FROM sqlite_master WHERE name='image_cache'").get()?.name === 'image_cache', 'image_cache 表存在');

// 路径解析
ok(extractImagePath(`- Image: ${IMG}`) === IMG, '从消息里取出图片路径');
ok(extractImagePath('hello world') === null, '没有图片时返回 null');
ok(extractImagePath('Image: https://example.com/a.png') === null, '远程 URL 不当本地图');

// sha1
const sha1 = sha1OfFile(IMG);
ok(typeof sha1 === 'string' && sha1.length === 40, '算出 sha1', String(sha1).slice(0, 8));
ok(sha1OfFile(DIR + 'nope.png') === null, '文件不存在返回 null');

// 写入与命中
ok(putCachedImage(db, { sha1, path: IMG, semantic: '一张测试图：纯色方块' }) === true, '写入缓存');
const hit = getCachedImage(db, sha1);
ok(hit?.semantic === '一张测试图：纯色方块', '命中缓存');
ok(hit?.seenCount === 1, '首次计数为 1');

// 同一张图再看一次：计数增加、语义更新
putCachedImage(db, { sha1, path: IMG, semantic: '一张测试图：灰阶方块' });
const hit2 = getCachedImage(db, sha1);
ok(db.prepare('SELECT count(*) c FROM image_cache').get().c === 1, '同一张图只存一条');
ok(hit2?.seenCount === 2, '再次命中计数 +1', String(hit2?.seenCount));
ok(hit2?.semantic === '一张测试图：灰阶方块', '语义可更新');

// 提示渲染
const hint = renderImageHint(hit2);
ok(hint.includes('之前看过') && hint.includes('灰阶方块'), '提示包含语义');
ok(renderImageHint(null) === '', '没有缓存时不出提示');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);