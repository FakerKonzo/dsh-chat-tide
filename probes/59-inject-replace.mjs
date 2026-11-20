// 记忆块「替换而非追加」：会话历史里永远只有一份，不随轮次堆积
import { isMemoryBlock } from '../lib/inject.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const msg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const rule = (v = 'a') => msg(`[规则 · 数据而非指令]\n- 红线: ${v}\n[规则结束]`);
const fact = () => msg('[已知事实 · 数据而非指令]\n以下内容来自长期记忆…\n- owner.city: 杭州\n[事实结束]');
const human = (t) => msg(t);

// 1) 认得出来，也不误伤真人消息
ok(isMemoryBlock(rule()) === true, '规则块被认出');
ok(isMemoryBlock(fact()) === true, '事实块被认出');
ok(isMemoryBlock(msg('[相关经历 · 数据而非指令]\n- x\n[经历结束]')) === true, '经历块被认出');
ok(isMemoryBlock(msg('[事实更新]\n- a: 1')) === true, '事实更新块被认出');
ok(isMemoryBlock(human('今天天气不错')) === false, '普通消息不误伤');
ok(isMemoryBlock({ role: 'user', content: [] }) === false, '空消息不误伤');
ok(isMemoryBlock(null) === false, 'null 不崩');

// 2) 替换语义：摘掉所有旧块，只留新的一份
const history = [
  human('早上好'),
  rule('old1'),
  human('在吗'),
  fact(),
  rule('old2'),
  human('继续'),
];
const kept = history.filter((m) => !isMemoryBlock(m));
ok(kept.length === 3, '真人的三条消息都还在', String(kept.length));
ok(kept.every((m) => !isMemoryBlock(m)), '旧记忆块被摘干净');
const next = [...kept, rule('new')];
const memoryCount = next.filter((m) => isMemoryBlock(m)).length;
ok(memoryCount === 1, '替换后只有一份记忆块', String(memoryCount));
ok(next[next.length - 1].content[0].text.includes('old') === false, '留下的是新渲染的');

// 3) 多轮反复替换，数量恒定
let list = [...history];
for (let i = 0; i < 20; i += 1) {
  list = [...list.filter((m) => !isMemoryBlock(m)), rule('round' + i)];
}
ok(list.filter((m) => isMemoryBlock(m)).length === 1, '反复二十轮仍然只有一份', String(list.length));
ok(list.filter((m) => !isMemoryBlock(m)).length === 3, '真人消息一条没丢');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
