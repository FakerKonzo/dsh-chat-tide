// 关注点向量命中体检：拿真实关注点向量，看自然说法能不能命中
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { getEmbedder } from '../lib/embed.js';
import { knn, distanceToCosine } from '../lib/vec.js';

const db = new DatabaseSync(process.env.MEMORY_DB ?? `${process.env.USERPROFILE}/.dsh/chat-memory/memory.db`, { allowExtension: true });
db.loadExtension(getLoadablePath());

const CASES = [
  ['那个方案咋样了', '应命中'],
  ['光伏材料是不是齐了', '应命中'],
  ['量化最近跑得如何', '应命中'],
  ['git 推送还报错吗', '应命中'],
  ['今天中午吃什么', '不应命中'],
  ['这歌单不错', '不应命中'],
];

const e = await getEmbedder({
  model: 'Xenova/bge-small-zh-v1.5',
  dtype: process.env.DTYPE ?? 'q8',
  cacheDir: process.env.MODEL_CACHE_DIR ?? new URL('../.cache/models', import.meta.url).pathname,
  remoteHost: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com',
});
if (!e.ready) {
  console.error('embedder 不可用:', e.error);
  process.exit(2);
}

const threshold = Number(process.argv[2] ?? 0.55);
const att = new Map(
  db
    .prepare("SELECT a.rowid AS rid, a.label FROM attention a WHERE a.status='active'")
    .all()
    .map((r) => [Number(r.rid), r.label]),
);

for (const [text, expect] of CASES) {
  const [vec] = await e.embed([text]);
  const near = knn(db, 'vec_attention', vec, 3);
  const top = near[0];
  const cos = top ? distanceToCosine(top.distance) : 0;
  const label = top ? att.get(Number(top.rowid)) ?? '?' : '—';
  const cos2b = near[1] ? distanceToCosine(near[1].distance) : 0;
  const margin = cos - cos2b;
  const soft = threshold - 0.05;
  const hit = cos >= threshold || (cos >= soft && margin >= 0.04);
  const okMark = (expect === '应命中') === hit ? 'OK  ' : '偏  ';
  const cos2 = near[1] ? distanceToCosine(near[1].distance) : 0;
  const label2 = near[1] ? att.get(Number(near[1].rowid)) ?? '?' : '—';
  console.log(`${okMark} ${cos.toFixed(3)}/二${cos2.toFixed(3)}/差${(cos-cos2).toFixed(3)} ${hit ? '命中' : '未中'} | ${text} → ${label}（${expect}）`);
}
db.close();
