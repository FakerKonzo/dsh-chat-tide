// 群聊里隐藏工具原始报错：只换给模型看的文本，失败这件事不变；私聊/本地/子代理都不动
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hideToolErrorDecision, scrubToolErrorText } from '../lib/scrub.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const accept = { kind: 'accept' };
const errResult = (code) => ({ isError: true, error: { message: 'Error: PTY shell exited during startup\n  at foo', info: code ? { name: 'X', code } : undefined } });
const group = { scope: 'group', conversationKey: 'qq:group:G1' };
const priv = { scope: 'c2c', conversationKey: 'qq:c2c:P1' };

// 1) 群聊 + 失败 + 开着：换成一句话，原始报错消失
const d1 = hideToolErrorDecision({ decision: accept, result: errResult('SESSION_QUERY_EVENT_NOT_FOUND'), toolName: 'bash', binding: group, enabled: true });
ok(d1 !== accept, '群聊里的失败被改写');
ok(d1.kind === 'accept', '仍然是 accept，不改变失败语义');
ok(d1.content?.[0]?.text?.includes('bash'), '说清是哪个工具', JSON.stringify(d1.content?.[0]?.text));
ok(!JSON.stringify(d1).includes('PTY shell exited'), '原始报错没进内容');
ok(d1.content[0].text.includes('SESSION_QUERY_EVENT_NOT_FOUND'), '短错误码保留，方便换路子');

// 2) 没错误码时也能给一句
const d2 = hideToolErrorDecision({ decision: accept, result: errResult(null), toolName: 'fetch', binding: group, enabled: true });
ok(d2.content[0].text.includes('fetch') && !d2.content[0].text.includes('PTY'), '无错误码时同样干净');

// 3) 私聊不动
const d3 = hideToolErrorDecision({ decision: accept, result: errResult('E'), toolName: 'bash', binding: priv, enabled: true });
ok(d3 === accept, '私聊原样放行');

// 4) 不在作用域（没有绑定，例如子代理）不动
const d4 = hideToolErrorDecision({ decision: accept, result: errResult('E'), toolName: 'bash', binding: null, enabled: true });
ok(d4 === accept, '没有会话绑定就不动');

// 5) 成功的调用不动
const d5 = hideToolErrorDecision({ decision: accept, result: { isError: false, value: 1 }, toolName: 'bash', binding: group, enabled: true });
ok(d5 === accept, '成功的调用不受影响');

// 6) 开关关掉就不动
const d6 = hideToolErrorDecision({ decision: accept, result: errResult('E'), toolName: 'bash', binding: group, enabled: false });
ok(d6 === accept, '开关关闭时原样放行');

// 7) 别人已经把这次调用 block 掉，就别把 block 变成 accept
const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] };
const d7 = hideToolErrorDecision({ decision: blocked, result: errResult('E'), toolName: 'bash', binding: group, enabled: true });
ok(d7 === blocked, 'block 决策不被改成 accept');

// 7b) 内层监听器加的上下文要保留
const ctxDecision = { kind: 'accept', additionalContexts: [{ role: 'user', content: [] }] };
const d7b = hideToolErrorDecision({ decision: ctxDecision, result: errResult('E'), toolName: 'bash', binding: group, enabled: true });
ok(d7b.additionalContexts === ctxDecision.additionalContexts, '附加上下文不丢');

// 8) 脱敏函数不会把长文本当错误码
const long = 'x'.repeat(200);
ok(!scrubToolErrorText('bash', long).includes(long), '超长错误码不保留');
ok(!scrubToolErrorText('bash', 'a b c/d\\e').includes('d\\e'), '含路径的错误码不保留');

// 9) 配置默认值是开的（config.js 依赖宿主包，这里看源码）
const cfgSrc = readFileSync(fileURLToPath(new URL('../lib/config.js', import.meta.url)), 'utf8');
ok(/hideToolErrors:\s*z\.boolean\(\)\.default\(true\)/.test(cfgSrc), '配置默认开启');
ok(readFileSync(fileURLToPath(new URL('../lib/schema.js', import.meta.url)), 'utf8').includes("'egress.hideToolErrors'"), '设置页有这一项');

// 10) 接线检查：apply 里确实挂了 tools/post-execute
const idxSrc = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
ok(idxSrc.includes("ctx.on('tools/post-execute'"), 'apply 注册了拦截');
ok(idxSrc.includes('hideToolErrorDecision('), '用的是同一个判定函数');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
