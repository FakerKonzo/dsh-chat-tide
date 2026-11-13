// 接茬概率：只在「灰区兜底判相关 且 L2 初筛命中」之后掷骰子。
// 未命中 L2 的绝不经手；direct / command 永不经过这里。

/**
 * L2 初筛：拿当前消息去比对已有 active 事实，判断是否有主题重叠。
 * @param {number[]} queryVec 归一化后的查询向量
 * @param {Array<{factId:string, vec:Float32Array}>} factVectors 归一化事实向量
 * @returns {{hit:boolean, score:number, factId:string|null}}
 */
export function screenAgainstL2(queryVec, factVectors, threshold = 0.45) {
  if (!queryVec || !factVectors?.length) return { hit: false, score: 0, factId: null };
  let best = 0;
  let bestId = null;
  for (const f of factVectors) {
    let dot = 0;
    const n = Math.min(queryVec.length, f.vec.length);
    for (let i = 0; i < n; i++) dot += queryVec[i] * f.vec[i];
    if (dot > best) {
      best = dot;
      bestId = f.factId;
    }
  }
  return { hit: best >= threshold, score: best, factId: bestId };
}

/**
 * L2 初筛通过后掷骰子。返回是否应该接茬，以及原因（写审计用）。
 * 只对 ambient 生效；direct / command 直接放行。
 */
export function shouldReplyToAmbient({
  label,
  l2 = { hit: false, score: 0 },
  probability = 0.1,
  random = Math.random,
}) {
  if (label !== 'ambient' && label !== 'relevant_ambient' && label !== 'uncertain') {
    return { reply: true, reason: 'not-ambient' };
  }
  if (probability <= 0) return { reply: false, reason: 'probability-off' };
  if (!l2.hit) return { reply: false, reason: 'no-l2-overlap', score: l2.score };
  if (probability >= 1) return { reply: true, reason: 'probability-always', score: l2.score };
  const hit = random() < probability;
  return { reply: hit, reason: hit ? 'probability-hit' : 'probability-miss', score: l2.score };
}
