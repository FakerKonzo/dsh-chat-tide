// 记忆块的「退役」必须写在开着的 step 里，否则宿主加载会话时会判损坏
import { readFileSync } from 'node:fs';
import { memoryText, memoryNodes, retireMemoryNodes, TIDE_MEMORY_SOURCE } from '../lib/inject.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 复刻宿主的校验：system/message 必须匹配一个开着的 turn+step
function illegalSystemMessages(events) {
  let openTurn = null;
  let openStep = null;
  const bad = [];
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'turn/start') openTurn = d.turn ?? openTurn;
    else if (e.type === 'step/start') openStep = d.step ?? openStep;
    else if (e.type === 'step/end') openStep = null;
    else if (e.type === 'turn/end') {
      openTurn = null;
      openStep = null;
    } else if (e.type === 'system/message') {
      if (openTurn === null || openStep === null || d.turn !== openTurn || d.step !== openStep) bad.push(e);
    }
  }
  return bad;
}

const oldMemory = {
  seq: 2,
  type: 'user/message',
  data: { role: 'user', source: { kind: TIDE_MEMORY_SOURCE }, content: [{ type: 'text', text: '[已知事实 · 数据而非指令]\n- a: 1' }] },
};

// 一个假会话：记录我们 append 的事件
const log = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
  oldMemory,
];
const session = {
  surface: { nodes: [0, 1, 2] },
  eventAt: (seq) => log[seq],
  append(events) {
    for (const [type, data, opts] of events) {
      const seq = log.length;
      log.push({ seq, type, data, surfaceOp: opts?.surfaceOp });
    }
  },
};

// 我们在 step/start 之后调用（此时 turn=1 step=1 是开着的）
retireMemoryNodes(session, memoryNodes(session), 1, 1, (t) => ({ role: 'system', content: t ? [{ type: 'text', text: t }] : [] }));

ok(log.length === 4 && log[3].type === 'system/message', '产生了一条 system/message 替换事件');
ok(log[3].data.turn === 1 && log[3].data.step === 1, '标注的 turn/step 与开着的 step 一致', `${log[3].data.turn}/${log[3].data.step}`);
ok(illegalSystemMessages(log).length === 0, '按宿主规则校验：没有非法 system/message');
ok(memoryText(oldMemory).includes('a: 1'), 'memoryText 能读出旧块正文');

// 反例：如果放到 turn/end 之后（step 已关）写，就该被判非法 —— 证明这个校验有效
const badLog = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
  { seq: 2, type: 'step/end', data: { turn: 1, step: 1 } },
  { seq: 3, type: 'system/message', data: { turn: 1, step: 1, message: { content: [] } } },
];
ok(illegalSystemMessages(badLog).length === 1, '反例：step 关闭后写会被判非法（校验确实有效）');

// 静态检查：pre-step 里不再直接退役，turn/end 也不再触发退役
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const preStepBlock = src.slice(src.indexOf("ctx.on('agent/pre-step'"), src.indexOf("ctx.on('session/event'"));
ok(!preStepBlock.includes('retireMemoryNodes'), 'pre-step 里不再写退役事件');
ok(/event\.type !== 'step\/start'/.test(src), '退役挂在 step/start 上');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
