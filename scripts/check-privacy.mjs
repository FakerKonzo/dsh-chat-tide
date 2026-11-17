// 隐私闸门：这个仓库是公开的，提交前必须确认没有把部署数据带出去。
// 检查「可以被别人看到」的东西：真实 openid、密钥样式的串、本机绝对路径。
// 用法：node scripts/check-privacy.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .filter((p) => !/^(node_modules|\.cache)\//.test(p));
  } catch {
    return null;
  }
}

/** 测试夹具里的占位写法：整段重复、分块重复、带明显前缀。 */
function isPlaceholder(s) {
  if (/^(PEER|OPENID|TEST|FAKE|SAMPLE|EG|ZZ)[A-Za-z0-9_]*$/.test(s)) return true;
  if (/^([0-9A-Za-z])\1+$/.test(s)) return true;
  // AAAA0000BBBB1111CCCC2222DDDD3333 这种每四位重复一次的块
  if (/^([0-9A-Fa-f])\1{3}([0-9A-Fa-f])\2{3}([0-9A-Fa-f])\3{3}([0-9A-Fa-f])\4{3}/.test(s)) return true;
  const distinct = new Set(s.replace(/[^0-9A-Za-z]/g, '')).size;
  return distinct <= 6;
}

const RULES = [
  { name: '真实 openid（32 位十六进制）', re: /\b[0-9A-Fa-f]{32}\b/g },
  { name: '疑似密钥（40 位以上连续串）', re: /\b[A-Za-z0-9_-]{40,}\b/g },
  { name: '本机绝对路径', re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, keepAll: true },
  { name: 'QQ 号样式的长数字', re: /\b\d{9,11}\b/g },
];

const files = trackedFiles();
if (files === null) {
  console.log('SKIP  不在 git 仓库里，跳过隐私检查');
  process.exit(0);
}

const problems = [];
for (const rel of files) {
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue; // 二进制
  }
  const lines = text.split('\n');
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      if (/掩码|例：|<your-|xxxx|allow:/i.test(line)) return;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line))) {
        const hit = m[0];
        if (!rule.keepAll && isPlaceholder(hit)) continue;
        // 占位式路径（C:\Users\<you>）不算
        if (rule.keepAll && /[<>\$]/.test(hit)) continue;
        problems.push({ file: rel, line: i + 1, rule: rule.name, hit: hit.slice(0, 10) + '…' });
      }
    });
  }
}

if (files.includes('presets/private.json')) {
  problems.push({ file: 'presets/private.json', line: 0, rule: '私人预置被跟踪', hit: '' });
}

console.log(`已检查 ${files.length} 个文件`);
if (!problems.length) {
  console.log('隐私闸门：通过（没有真实标识、密钥或本机路径）');
  process.exit(0);
}
const seen = new Set();
for (const p of problems) {
  const key = `${p.file}:${p.line}:${p.rule}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (seen.size > 20) continue;
  console.log(`  ${p.file}:${p.line}  ${p.rule}  ${p.hit}`);
}
console.log(`隐私闸门：发现 ${problems.length} 处可疑内容`);
process.exit(1);
