// 增量注入逻辑自测（纯函数级：模拟两次注入的拼装与状态推进）
import { renderFactBlock, renderEventBlock } from '../lib/context.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

/** 复刻 index.js 里的增量拼装逻辑 */
function buildDelta({ facts, events, prev }) {
  const factBlock = renderFactBlock(facts, { maxChars: 1200 });
  const p = prev ?? { factBlock: '', eventAt: 0 };
  const factDelta = factBlock && factBlock !== p.factBlock ? factBlock : '';
  const newEvents = events.filter((e) => (e.occurredAt ?? e.observedAt ?? 0) > (p.eventAt ?? 0));
  const eventDelta = newEvents.length ? renderEventBlock(newEvents, { maxChars: 600 }) : '';
  const block = [factDelta, eventDelta].filter(Boolean).join('\n\n');
  const newestAt = events.reduce((m, e) => Math.max(m, e.occurredAt ?? e.observedAt ?? 0), p.eventAt ?? 0);
  return { block, state: { factBlock: factBlock || p.factBlock, eventAt: newestAt } };
}

const facts = [{ canonicalKey: 'solar_project', value: '屋顶光伏方案', tier: 'human_explicit', subtype: 'profile' }];
const ev1 = [{ content: '今天吃了三个饼', occurredAt: 1000 }];

// 第一轮：全量
const r1 = buildDelta({ facts, events: ev1, prev: null });
ok(r1.block.includes('屋顶光伏方案') && r1.block.includes('三个饼'), '第一轮注入事实+经历');

// 第二轮：无变化 → 不注入
const r2 = buildDelta({ facts, events: ev1, prev: r1.state });
ok(r2.block === '', '事实与经历都没变 → 不注入');

// 第三轮：新增一条经历 → 只给新经历
const ev2 = [...ev1, { content: '晚上吃了火锅', occurredAt: 2000 }];
const r3 = buildDelta({ facts, events: ev2, prev: r2.state });
ok(r3.block.includes('火锅') && !r3.block.includes('三个饼'), '只注入新经历', JSON.stringify(r3.block.slice(0, 40)));
ok(!r3.block.includes('屋顶光伏方案'), '事实未变不再重复');

// 第四轮：事实变化 → 只给事实
const facts2 = [...facts, { canonicalKey: 'city', value: '杭州', tier: 'human_explicit', subtype: 'profile' }];
const r4 = buildDelta({ facts: facts2, events: ev2, prev: r3.state });
ok(r4.block.includes('屋顶光伏方案') && r4.block.includes('杭州'), '事实变化时重发事实块');
ok(!r4.block.includes('火锅'), '经历没有新增就不重复');

// 第五轮：又无变化
const r5 = buildDelta({ facts: facts2, events: ev2, prev: r4.state });
ok(r5.block === '', '再次无变化 → 不注入');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
