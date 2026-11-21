// 四件核心能力：按需接茬 / 主动拒答 / 记事把关 / 规则与事实注入
// 细节会变，这四条不能丢；有人改动时这里先亮红灯
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SILENT_TOOL, isSilentCall } from '../lib/egress.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const idx = read('../lib/index.js');
const cfgSrc = read('../lib/config.js');

// 一、群聊按需接茬：路由闸门存在，且能零模型成本地丢弃
ok(/agent\/pre-step/.test(idx) && idx.includes('features.routing'), '有群聊初筛闸门');
ok(idx.includes("kind: 'reject'"), '能拒绝进入模型调用');
ok(/attentionThreshold|decideRoute/.test(idx), '判定依据是关注点/概率，不是无脑接');

// 二、主动拒答：模型有工具可调，且调用后正文必被丢弃
ok(!!SILENT_TOOL, '存在拒答工具常量');
ok(idx.includes(`name: '${SILENT_TOOL}'`), '拒答工具已注册');
ok(/if \(cfg\.features\.tools !== false\)/.test(idx), '拒答通道不被出站闸门开关卡住');
ok(isSilentCall([SILENT_TOOL]) === true, '闸门认得这个工具名');
ok(idx.includes('不要用「（图跳过）」'), '工具契约里写明用它代替占位话');

// 三、记事把关：入站镜像 + 预筛 + 抽取跟随会话模型 + 分人归属
ok(idx.includes('appendRawLog'), '入站先落原始记录');
ok(idx.includes('looksMemorable'), '抽取前有预筛，不是每句都丢给模型');
ok(/payload\?\.modelSelection/.test(idx), '抽取跟随会话模型，不自选');
ok(idx.includes('speakerName'), '抽取带说话人，避免张冠李戴');
ok(cfgSrc.includes('storeFacts') && cfgSrc.includes('storeEvents'), '三类内容可分别开关');

// 四、规则与事实注入：规则块、事实块、经历块都在，且有预算与重发
ok(idx.includes('buildInjection'), '有统一的注入组装');
ok(/ruleMaxChars/.test(cfgSrc) && /maxChars/.test(cfgSrc), '规则与事实各有字符预算');
ok(read('../lib/prompt.js').includes('renderRuleSection'), '规则走系统提示段');
ok(idx.includes("ctx.on('system-prompt/assemble'"), '系统提示装配已挂钩');
ok(idx.includes('ruleScopeOf') || idx.includes('selectRuleFacts'), '规则按会话类型取');
ok(read('../lib/inject.js').includes('withSpeaker: true'), '事实注入带归属人');

console.log(fail === 0 ? '\n四件核心能力都在' : `\n${fail} 项缺失`);
process.exit(fail === 0 ? 0 : 1);
