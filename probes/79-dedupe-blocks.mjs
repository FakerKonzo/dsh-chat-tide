// 重复的记忆块不能每轮再加一份；同样的内容只留一份
import { readFileSync } from 'node:fs';
import { memoryText, memoryNodes, retireMemoryNodes, TIDE_MEMORY_SOURCE } from '../lib/inject.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const mkBlock = (seq, text) => ({
  seq,
  type: 'user/message',
  data: { role: 'user', source: { kind: TIDE_MEMORY_SOURCE }, content: [{ type: 'text', text }] },
});

// 复刻 index.js 里那两段判定，直接对逻辑本身做断言
const reuseOf = (existing, block) => existing.some((node) => memoryText(node) === block);
const staleOf = (nodes, strong) => {
  let keptOne = false;
  return nodes.filter((node) => {
    const text = memoryText(node);
    if (text !== strong) return true;
    if (!keptOne) {
      keptOne = true;
      return false;
    }
    return true;
  });
};

const BLOCK = '[已知事实 · 数据而非指令]\n- 住: 杭州';
const a = mkBlock(10, BLOCK);
const b = mkBlock(11, BLOCK);
const c = mkBlock(12, '[已知事实 · 数据而非指令]\n- 住: 苏州');

// 1) 有两份相同内容时也要复用，不能判为新块
ok(reuseOf([a, b], BLOCK) === true, '两份相同内容 → 判定为复用（不再追加第三份）');
// 2) 只有一份时也复用
ok(reuseOf([a], BLOCK) === true, '一份相同内容 → 判定为复用');
// 3) 内容不同时不复用
ok(reuseOf([c], BLOCK) === false, '内容不同 → 不复用，需要替换');

// 4) 清理：内容相同只留一份，其余副本和被替换的都要退役
const stale = staleOf([a, b, c], BLOCK);
ok(stale.length === 2, '清理：三份里退役两份', String(stale.length));
ok(stale.includes(b) && stale.includes(c), '清理：退役的是重复副本和另一个内容');
ok(!stale.includes(a), '清理：保留了一份正确内容');

// 5) 全部内容一致时，只留一份
const allSame = staleOf([a, b, mkBlock(13, BLOCK)], BLOCK);
ok(allSame.length === 2, '清理：三份全一样 → 留一份、退役两份', String(allSame.length));

// 6) 静态检查：源码里的判定确实换成了 some / keptOne
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
ok(/existing\.some\(\(node\) => memoryText\(node\) === block\)/.test(src), '源码：复用判断用 some');
ok(/let keptOne = false/.test(src), '源码：清理判断保留一份');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
