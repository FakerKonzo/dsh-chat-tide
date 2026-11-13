// LLM 兜底自测。
import { classifyByLlm, parseLabel } from '../lib/llmroute.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

ok(parseLabel('relevant_ambient') === 'relevant_ambient', '直出标签');
ok(parseLabel('  IRRELEVANT_AMBIENT\n') === 'irrelevant_ambient', '大小写/空白容错');
ok(parseLabel('这条消息不相关') === 'irrelevant_ambient', '中文兜底');
ok(parseLabel('我觉得还行') === 'uncertain', '无法识别 → uncertain');
ok(parseLabel('') === 'uncertain', '空输出 → uncertain');

const completeRelevant = async () => 'relevant_ambient';
ok((await classifyByLlm({ complete: completeRelevant, text: '小黑在吗' })) === 'relevant_ambient', '相关判定');

const completeBad = async () => '随便说点什么';
ok((await classifyByLlm({ complete: completeBad, text: '今天天气' })) === 'uncertain', '非法输出降级 uncertain');

const completeThrow = async () => {
  throw new Error('llm down');
};
ok((await classifyByLlm({ complete: completeThrow, text: '在吗' })) === 'uncertain', '模型失败降级 uncertain');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
