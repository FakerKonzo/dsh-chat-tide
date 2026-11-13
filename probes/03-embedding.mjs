// 探针 3：@huggingface/transformers 加载 bge-small-zh-v1.5、CPU 推理延迟、语义合理性。
import { env, pipeline } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';

// 模型缓存目录由 MODEL_CACHE_DIR 或 embedding.cacheDir 指定
env.cacheDir = process.env.MODEL_CACHE_DIR ?? fileURLToPath(new URL('../.cache/models', import.meta.url));
if (process.env.HF_ENDPOINT) {
  env.remoteHost = process.env.HF_ENDPOINT.replace(/\/+$/, '');
  console.log('remoteHost =', env.remoteHost);
} else {
  console.log('remoteHost =', env.remoteHost, '(未设置 HF_ENDPOINT)');
}

const MODEL = 'Xenova/bge-small-zh-v1.5';
const DIM = 512;

let extractor;
const t0 = Date.now();
try {
  extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  console.log(`模型加载耗时 ${Date.now() - t0}ms`);
} catch (e) {
  console.log('模型加载 FAILED:', e.message.slice(0, 300));
  process.exit(3);
}

async function embed(text) {
  const out = await extractor([text], { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

const texts = [
  '主人说下周三要去杭州出差',
  '群里在聊量化回测的缺口',
  '鲸鱼娘喜欢喝奶茶但不喜欢加冰',
  '今天走了好多路，好累',
  '在吗？有人吗',
  '明天记得交周报',
  '这个方案的风险点在哪',
  '帮我看看这段代码为什么报错',
  '周末想去爬山',
  '最近睡眠不太好',
];

const lat = [];
let dim = 0;
for (const t of texts) {
  const s = Date.now();
  const v = await embed(t);
  lat.push(Date.now() - s);
  dim = v.length;
}
lat.sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
console.log(`维度 ${dim}（期望 ${DIM}）`);
console.log(`延迟 P50 ${p(0.5)}ms  P95 ${p(0.95)}ms  max ${lat[lat.length - 1]}ms`);

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

const pairs = [
  ['杭州', '西湖在哪个城市'],
  ['杭州', '奶茶加不加冰'],
  ['量化回测', '策略的夏普比率'],
  ['量化回测', '周末去爬山'],
];
for (const [a, b] of pairs) {
  const [va, vb] = [await embed(a), await embed(b)];
  console.log(`  cos(${a}, ${b}) = ${cosine(va, vb).toFixed(3)}`);
}
