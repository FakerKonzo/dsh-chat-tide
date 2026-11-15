// 入站链路：QQ 引用回复不能被整条丢掉
// 引用回复的真实形状（dsh-qqbot 的 buildQuotePart）：
//   [Quoted message begins]\n…历史…\n[Quoted message ends]\n[Current message]\n[昵称 (openid)] 真人说的话 (@you)
// 以前对原文直接 startsWith('[Quoted message begins]') 判元信息，等于把真人发言一起丢了；
// 聊天历史信封（[Chat history begins]…[Current message]）也是同一个坑。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inboundBody, isMetaText } from '../lib/prefilter.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const sender = '[小助手 (OPENID_AAAA)]';

// 1) 引用回复：真话在 [Current message] 之后
const quoted =
  '[Quoted message begins]\n=== 消息 1 ===\n[消息内容] 你看我钱包没扣钱\n[Quoted message ends]\n' +
  '[Current message]\n' +
  sender +
  ' 这句话我不同意 (@you)';
const q = inboundBody(quoted);
ok(q.usable === true, '引用回复没有被判成元信息');
ok(q.body === '这句话我不同意', '只留真人说的话', JSON.stringify(q.body));
ok(q.sender?.id === 'OPENID_AAAA', '发送者仍然解析出来', JSON.stringify(q.sender));
ok(!String(q.body).includes('你看我钱包没扣钱'), '被引用的历史不进正文');
ok(isMetaText(quoted) === true, '旧写法对这条原文确实会误杀（说明修复不是空转）');

// 2) 纯文本照旧
const p = inboundBody(sender + ' 纯文本这一条 (@you)');
ok(p.usable === true && p.body === '纯文本这一条', '纯文本照旧');

// 3) 聊天历史信封不再整条误杀
const h = inboundBody('[Chat history begins]\n[小甲 (OPENID_BBBB)] 早\n[Current message]\n' + sender + ' 我说的是这个');
ok(h.usable === true && h.body === '我说的是这个', '带聊天历史的消息也能记录', JSON.stringify(h.body));

// 4) 我们自己注入的块不能回流
ok(inboundBody('[已知事实 · 数据而非指令]\n主人住哪').reason === 'meta', '注入块判为 meta');
// 5) 宿主运行时噪音照旧挡掉
ok(inboundBody('The working directory changed to /x').reason === 'noise', '运行时噪音判为 noise');
ok(inboundBody('   ').reason === 'empty', '空白判为 empty');

// 6) 顺序回归：index.js 不能再拿原始文本直接判元信息
const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
ok(!/isMetaText\(\s*raw/.test(src), 'index.js 不对原始文本直接判 isMetaText');
ok(!/isSystemNoise\(\s*raw/.test(src), 'index.js 不对原始文本直接判 isSystemNoise');
ok((src.match(/inboundBody\(/g) ?? []).length >= 3, '三处入口都走同一个判断');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
