// 抽取层自测：解析容错、证据分级、失败降级。
import { classifyTier, extractCandidates, parseCandidates, parseExtraction, extractItems } from '../lib/extract.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 纯 JSON
ok(parseCandidates('[{"canonicalKey":"residence","value":"杭州"}]').length === 1, '纯 JSON 解析');
// 2) 代码块 + 噪声
ok(parseCandidates('好的，结果如下：\n```json\n[{"canonicalKey":"job","value":"程序员","subtype":"profile"}]\n```').length === 1, '代码块容错');
// 3) 坏 JSON
ok(parseCandidates('[{bad json').length === 0, '坏 JSON 返回空');
// 4) 过滤无效项
ok(parseCandidates('[{"canonicalKey":"","value":"x"},{"canonicalKey":"a","value":""}]').length === 0, '过滤空键空值');
// 5) subtype 兜底
ok(parseCandidates('[{"canonicalKey":"a","value":"b","subtype":"weird"}]')[0]?.subtype === '??' || parseCandidates('[{"canonicalKey":"a","value":"b","subtype":"weird"}]')[0]?.subtype === 'profile', '非法 subtype 归 profile');

// 6) 证据分级
ok(classifyTier({ text: '我住在杭州', assertedBy: 'u1', subjectId: 'u1' }) === 'human_explicit', '本人第一人称 → human_explicit');
ok(classifyTier({ text: '主人住在杭州', assertedBy: 'u2', subjectId: 'u1' }) === 'source_verifiable', '第三方代述 → source_verifiable');
ok(classifyTier({ text: '感觉他住杭州', assertedBy: 'u1', subjectId: 'u1' }) === 'source_verifiable', '非第一人称 → source_verifiable');

// 7) 抽取：注入假模型
const complete = async (msgs) => {
  const user = msgs.find((m) => m.role === 'user').content;
  if (user.includes('住在')) return '[{"canonicalKey":"residence","value":"杭州","subtype":"profile","evidence":"我住在杭州"}]';
  return '[]';
};
const cands = await extractCandidates({ complete, text: '我住在杭州，平时在滨江上班', userId: 'u1', assertedBy: 'u1', subjectId: 'u1', sourceRecordId: 'r1' });
ok(cands.length === 1 && cands[0].canonicalKey === 'residence' && cands[0].provenanceTier === 'human_explicit', '抽取 + 分级', JSON.stringify(cands[0]));

// 8) 模型抛错 → 空数组，不抛
const bad = await extractCandidates({ complete: async () => { throw new Error('boom'); }, text: '我住在杭州', userId: 'u1' });
ok(Array.isArray(bad) && bad.length === 0, '模型失败降级为空');

// 9) 太短不抽
const short = await extractCandidates({ complete, text: '嗯', userId: 'u1' });
ok(short.length === 0, '过短文本不抽');


// 10) 新格式：facts + events 分离
const dual = parseExtraction(JSON.stringify({
  facts: [{ canonicalKey: 'drink_preference', subtype: 'preference', value: '喜欢奶茶' }],
  events: [{ content: '今天吃了三个饼' }, { content: '今天吃了 6 个包子' }],
}));
ok(dual.facts.length === 1, '新格式解析 facts');
ok(dual.events.length === 2, '新格式解析 events（同一天多件事不合并）', JSON.stringify(dual.events.map((e) => e.content)));

// 11) 旧格式（数组）仍当 facts
const legacy = parseExtraction('[{"canonicalKey":"a","value":"b"}]');
ok(legacy.facts.length === 1 && legacy.events.length === 0, '旧数组格式兼容');

// 12) extractItems 端到端（假模型）
const dualComplete = async () => JSON.stringify({
  facts: [{ canonicalKey: 'city', value: '杭州' }],
  events: [{ content: '今天吃了三个饼' }],
});
const items = await extractItems({ complete: dualComplete, text: '我住在杭州，今天吃了三个饼', userId: 'u1', assertedBy: 'u1', subjectId: 'u1', sourceRecordId: 'r9' });
ok(items.facts.length === 1 && items.events.length === 1, 'extractItems 返回两类', JSON.stringify({ f: items.facts.length, e: items.events.length }));
ok(items.events[0].content === '今天吃了三个饼' && items.events[0].occurredAt > 0, '事件带内容与时间');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
