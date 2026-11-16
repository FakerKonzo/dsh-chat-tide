// 沉默就是零输出：括号旁白不能被当成一条消息发出去
import { isNarrationOnly } from '../lib/egress.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 今晚真实发出去的那两条
ok(isNarrationOnly('（图跳过）') === true, '（图跳过）判为旁白');
ok(isNarrationOnly('（图不看了）') === true, '（图不看了）判为旁白');
ok(isNarrationOnly('（不回复）') === true, '（不回复）判为旁白');
ok(isNarrationOnly('（图跳过）（真的）') === true, '多个括号连在一起也算');
ok(isNarrationOnly('(skip image)') === true, '半角括号同样处理');
ok(isNarrationOnly('  （图跳过）\n') === true, '前后空白不影响判定');

// 2) 有正文的绝不能误伤
ok(isNarrationOnly('（图跳过）但这事我得说一句') === false, '括号后有正文不拦');
ok(isNarrationOnly('这个我看了，是张小笼包的照片') === false, '正常回复不拦');
ok(isNarrationOnly('行（明天再说）') === false, '句中括号不拦');
ok(isNarrationOnly('这是我的（唯一）办法') === false, '括号在句中不拦');
ok(isNarrationOnly('') === false, '空文本不判为旁白（交给下游判空）');
ok(isNarrationOnly('（）') === true, '空括号也算旁白');

// 3) 声明式旁白不在机械拦截范围，得靠规矩
ok(isNarrationOnly('这条不是问我的，我就不接话了') === false, '声明式旁白不由过滤器处理');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
