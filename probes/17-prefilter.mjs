// 预筛自测
import { isMetaText, looksMemorable } from '../lib/prefilter.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 元信息
ok(isMetaText('Current runtime context. This snapshot supersedes'), '运行时上下文 → 元信息');
ok(isMetaText('Time sampled while preparing turn 2, step 1'), '时间戳元信息');
ok(isMetaText('<system-reminder>\nx'), 'system-reminder');
ok(isMetaText('[model changed: x]'), '模型切换提示');
ok(!isMetaText('我是你主人啊'), '正常对话不是元信息');

// 值得记
ok(looksMemorable('我住在杭州，平时在滨江上班'), '第一人称陈述');
ok(!looksMemorable('喊你呢，小肥鱼'), '纯招呼（无可记线索）不抽');
ok(looksMemorable('主人喜欢喝不加冰的奶茶'), '偏好句');
ok(!looksMemorable(''), '空串不抽');
ok(!looksMemorable('哈哈哈'), '纯语气不抽');
ok(!looksMemorable('https://example.com/abc'), '纯链接不抽');
ok(!looksMemorable('Current runtime context. blah'), '元信息不抽');
ok(!looksMemorable('嗯'), '过短不抽');
ok(!looksMemorable('我'), '单字不抽');

// minChars 可调
ok(!looksMemorable('我喜欢猫', { minChars: 6 }) || '我喜欢猫'.length >= 6, 'minChars 边界');
ok(looksMemorable('我喜欢猫', { minChars: 2 }), '放宽 minChars 后可抽');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
