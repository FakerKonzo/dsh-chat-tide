// embedder worker 自测（真实模型；缓存已存在时很快）
import { getEmbedder, resetEmbedder } from '../lib/embed.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const e = await getEmbedder({
  remoteHost: 'https://hf-mirror.com',
  useWorker: true,
  cacheDir: process.env.MODEL_CACHE_DIR ?? undefined,
});
console.log('embedder ready:', e.ready, 'name:', e.name, 'dim:', e.dim, 'error:', e.error ?? '');
if (!e.ready) {
  console.log('SKIP  embedder 未就绪（多半是模型没下载）：', e.error ?? 'unknown');
  resetEmbedder();
  process.exit(0);
}
ok(e.ready === true, 'embedder 就绪');
if (e.ready) {
  const [a, b, c] = await e.embed(['杭州西湖', '西湖在哪个城市', '奶茶加不加冰']);
  ok(a.length === 512 && b.length === 512, '维度 512', `${a.length}`);
  const cos = (x, y) => {
    let d = 0;
    for (let i = 0; i < x.length; i++) d += x[i] * y[i];
    return d;
  };
  const near = cos(a, b);
  const far = cos(a, c);
  console.log(`  cos(杭州西湖, 西湖在哪)=${near.toFixed(3)} cos(杭州西湖, 奶茶)=${far.toFixed(3)}`);
  ok(near > far, '相关对子得分更高');

  // 并发调用（序列号匹配）
  const res = await Promise.all([e.embed(['一']), e.embed(['二']), e.embed(['三'])]);
  ok(res.length === 3 && res.every((r) => r[0].length === 512), '并发调用正确');
}
resetEmbedder();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
