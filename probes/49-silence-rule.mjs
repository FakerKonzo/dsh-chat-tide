// 群里不想接话要走工具，不是写一句占位话；规矩里点名的工具名必须真实存在
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SILENT_TOOL, REPLY_TOOL } from '../lib/egress.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const generic = JSON.parse(read('../presets/rules/generic.json'));

// 1) 预置里必须有一条明确要求"调用工具拒绝"的群聊规矩
const rule = generic.rules.find((r) => r.key === 'rule.group_silence_tool');
ok(!!rule, '预置里有群聊沉默规矩');
ok(rule?.appliesTo === 'group', '这条只在群聊生效', String(rule?.appliesTo));
ok(rule?.value.includes(SILENT_TOOL), '点名的正是 stay_silent', SILENT_TOOL);
ok(!/不要回|别回话/.test(rule?.value ?? ''), '不是只说"别回"，而是要求走工具');

// 2) 规矩里提到的工具名必须和代码常量一致，改名时不能悄悄失配
const src = read('../lib/index.js');
ok(src.includes(`name: '${SILENT_TOOL}'`), 'stay_silent 工具确实注册了');
ok(src.includes(`name: '${REPLY_TOOL}'`), 'reply 工具确实注册了');

// 3) 出站闸门必须真的认这个工具名
const egressSrc = read('../lib/egress.js');
ok(egressSrc.includes(`const SILENT_TOOL = '${SILENT_TOOL}'`), '出站闸门与工具名同源');

// 3b) 工具说明本身也要把用法写死（注入关着时，这是唯一能到达模型的约束）
ok(/不要用.{0,6}（图跳过）/.test(src), '工具说明里点名禁止占位话');
ok(src.includes('群里一个字都收不到'), '工具说明说清后果');

// 4) 规矩写法符合预置格式
ok(/^rule\.[a-z0-9_.]+$/.test(rule?.key ?? ''), '键名符合 rule.* 命名');
ok((rule?.value ?? '').length >= 4 && (rule?.value ?? '').length <= 600, '长度在预置允许范围内');
const applies = ['any', 'group', 'private', 'local'];
ok(generic.rules.every((r) => !r.appliesTo || applies.includes(r.appliesTo)), '所有场景值合法');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
