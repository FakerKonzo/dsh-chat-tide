// QQ 信封解析自测
import { cleanBody, normalizeInbound, isSystemNoise } from '../lib/qqtext.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const group = '[Chat history begins]\n[A (111)] 牛哇\n[B (222)] 周末去爬山\n[Chat history ends]\n[Current message]\n[小明 (AAAA0000BBBB1111CCCC2222DDDD3333)] <@E5522D401FA491B4AC4BEBF1CFD822BE> 今天吃了 6 个包子 (@you)';
const g = normalizeInbound(group);
ok(g.hadEnvelope === true, '识别信封');
ok(g.sender?.id === 'AAAA0000BBBB1111CCCC2222DDDD3333', '取出信封里的发送者', g.sender?.name);
ok(g.current === '今天吃了 6 个包子', '只留当前消息正文', JSON.stringify(g.current));

const priv = normalizeInbound('今天我吃了三个饼');
ok(priv.hadEnvelope === false && priv.current === '今天我吃了三个饼', '私聊无信封整段即正文');
ok(priv.sender === null, '私聊无发送者前缀');

ok(normalizeInbound('[Current message]\n正文而已').current === '正文而已', '无发送者前缀的当前消息');
ok(normalizeInbound('[Chat history begins]\n[A] 牛哇\n[Chat history ends]').current.startsWith('[Chat history'), '只有历史时原样返回（外层会过滤）');
ok(cleanBody('<@ABC> 你好 (@you)') === '你好', '去 @ 标记与 (@you)');
ok(cleanBody('多   个   空格') === '多 个 空格', '压缩空白');

ok(isSystemNoise('The working directory changed from "D:/" to "D:/x".'), '工作目录变更算系统噪音');
ok(isSystemNoise('[Chat history begins]\n...'), '历史缓冲算系统噪音');
ok(!isSystemNoise('今天我吃了三个饼'), '正常消息不是噪音');

const g2 = normalizeInbound('[Chat history begins]\n[X (1)] 无关\n[Current message]\n[如烟 (65302BD6DDC8AAAF8DF0B4652352AC37)] \n');
ok(g2.current === '' && g2.sender?.name === '如烟', '空消息只剩发送者时正文为空', JSON.stringify(g2.current));

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
