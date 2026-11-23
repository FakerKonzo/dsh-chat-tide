// 剥离思考块：模型不该读到自己上一轮的想法（坏习惯会自我强化）
import { stripReasoning, isMemoryBlock } from '../lib/inject.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const assistant = (reasoning, text) => ({
  role: 'assistant',
  content: [
    ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
    ...(text ? [{ type: 'text', text }] : []),
  ],
});

// 1) 思考块被剥掉，正文留着
const one = stripReasoning([assistant('我该不该接话……算了发个句号吧', '好的')]);
ok(one[0].content.length === 1, '只剩正文一块', String(one[0].content.length));
ok(one[0].content[0].type === 'text' && one[0].content[0].text === '好的', '正文原样保留');
ok(!JSON.stringify(one).includes('句号'), '思考内容确实不在里面了');

// 2) 只有思考没有正文：整条变成空内容，但不崩
const only = stripReasoning([assistant('只有想法', '')]);
ok(only[0].content.length === 0, '纯思考消息变成空内容');

// 3) 没有思考块的消息原样返回（同一个对象，不制造无谓拷贝）
const plain = { role: 'user', content: [{ type: 'text', text: '在吗' }] };
ok(stripReasoning([plain])[0] === plain, '没思考块的消息原样返回');

// 4) 工具调用与工具结果不受影响
const toolish = {
  role: 'assistant',
  content: [
    { type: 'reasoning', text: '先查一下' },
    { type: 'tool-call', id: 'c1', name: 'run_code', arguments: '{}' },
  ],
};
const keptTool = stripReasoning([toolish])[0];
ok(keptTool.content.length === 1 && keptTool.content[0].type === 'tool-call', '工具调用保留');

// 5) 记忆块判定不受影响
ok(isMemoryBlock({ role: 'user', content: [{ type: 'text', text: '[已知事实 · 数据而非指令]\n- a: b\n[事实结束]' }] }) === true, '记忆块仍能认出');

// 6) 边界：非数组、空数组、怪消息
ok(Array.isArray(stripReasoning(null)) && stripReasoning(null).length === 0, 'null 返回空数组');
ok(stripReasoning([]).length === 0, '空数组仍然是空');
ok(stripReasoning([{ role: 'user' }])[0].role === 'user', '没有 content 的消息不崩');

// 7) 剥掉之后体积明显下降（这是真正想要的收益）
const big = `[{'role':'assistant','content':[{'type':'reasoning','text':'${'想'.repeat(2000)}'}]}]`;
const parsed = JSON.parse(big.replace(/'/g, '"'));
const after = stripReasoning(parsed);
ok(JSON.stringify(after).length < 60, '两千字思考被剥掉后只剩空壳', String(JSON.stringify(after).length));

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
