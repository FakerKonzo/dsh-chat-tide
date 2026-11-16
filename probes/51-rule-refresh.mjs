// 规则块不能只发一次：长会话里会被挤出上下文，得隔一段轮次重发
import { diffInjection } from '../lib/inject.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const built = { ruleBlock: '[规则 · 数据而非指令]\n- a: b', factBlock: '', eventBlock: '', events: [] };

// 1) 首次：没有历史，一定要发
const first = diffInjection({ built, prev: {}, cfg: {}, turn: 1 });
ok(first.ruleDelta !== '', '首次注入规则');
ok(first.ruleSent === true, '标记为已发');

// 2) 内容没变、轮次没到：不重复发
const prevAfterFirst = { ruleBlock: built.ruleBlock, ruleTurn: 1, eventIds: [] };
const near = diffInjection({ built, prev: prevAfterFirst, cfg: {}, turn: 5 });
ok(near.ruleDelta === '', '间隔内不重发');

// 3) 到了重发间隔：强制再发一次
const stale = diffInjection({ built, prev: prevAfterFirst, cfg: {}, turn: 21 });
ok(stale.ruleDelta !== '', '到间隔就重发', String(21 - 1));
ok(stale.ruleSent === true, '重发也记轮次');

// 4) 间隔可配，0 表示永不重发
const never = diffInjection({ built, prev: prevAfterFirst, cfg: { ruleRefreshTurns: 0 }, turn: 999 });
ok(never.ruleDelta === '', '设为 0 就不重发');

// 5) 内容变了立刻发，不用等间隔
const changed = { ...built, ruleBlock: built.ruleBlock + '\n- c: d' };
const onchange = diffInjection({ built: changed, prev: prevAfterFirst, cfg: {}, turn: 3 });
ok(onchange.ruleDelta !== '', '内容变化立即重发');

// 6) 没有规则时不产生空块
const empty = diffInjection({ built: { ...built, ruleBlock: '' }, prev: {}, cfg: {}, turn: 1 });
ok(empty.ruleDelta === '', '没有规则不发空块');
ok(empty.ruleSent === false, '没发就不记轮次');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
