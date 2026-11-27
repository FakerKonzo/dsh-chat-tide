// embedder 崩溃自愈：子进程被杀后，getEmbedder 必须重建，而不是一直用死实例
// 真实模型，需要缓存（run-checks --skip-model 会跳过本探针）
import { execSync } from 'node:child_process';
import { getEmbedder, resetEmbedder } from '../lib/embed.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

/** 找本进程直接子进程里跑 embed-child.mjs 的那个，返回 pid 列表 */
function embedChildPids() {
  try {
    if (process.platform === 'win32') {
      const ps = [
        'Get-CimInstance Win32_Process',
        `| Where-Object { $_.CommandLine -like '*embed-child.mjs*' -and $_.CommandLine -notlike '*Get-CimInstance*' -and $_.ParentProcessId -eq ${process.pid} }`,
        '| Select-Object -ExpandProperty ProcessId',
      ].join(' ');
      const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split(/\s+/).map(Number).filter(Boolean);
    }
    const out = execSync('ps -Ao pid=,ppid=,args=', { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((cols) => cols.length > 2 && Number(cols[1]) === process.pid)
      .filter((cols) => cols.slice(2).join(' ').includes('embed-child.mjs'))
      .map((cols) => Number(cols[0]))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const e1 = await getEmbedder({ cacheDir: process.env.MODEL_CACHE_DIR ?? undefined });
if (!e1.ready) {
  console.log('SKIP  embedder 未就绪（多半是模型没下载）：', e1.error ?? 'unknown');
  resetEmbedder();
  process.exit(0);
}
ok(e1.ready === true, 'embedder 就绪');

const before = await e1.embed(['测试一句']);
ok(before[0].length === 512, '首次向量化成功');

const pids = embedChildPids();
if (pids.length === 0) {
  console.log('SKIP  找不到子进程 pid（改动过实现就更新这里）');
  resetEmbedder();
  process.exit(0);
}
for (const pid of pids) {
  try {
    process.kill(pid);
  } catch {
    /* 已经退了 */
  }
}
// 等 exit 回调跑完
await new Promise((r) => setTimeout(r, 600));

let died = false;
try {
  await e1.embed(['崩溃之后']);
} catch {
  died = true;
}
ok(died, '旧实例已判死，调用报错而不是一直挂着');

const e2 = await getEmbedder({ cacheDir: process.env.MODEL_CACHE_DIR ?? undefined });
ok(e2 !== e1, 'getEmbedder 拿到的是新实例');
ok(e2.ready === true, '新实例可用');
const after = await e2.embed(['重建之后']);
ok(after[0].length === 512, '重建后向量化成功');

const pending = e2.embed(['卸载中的请求']);
resetEmbedder();
let rejected = false;
try { await pending; } catch { rejected = true; }
ok(rejected, '卸载使在途请求立即结束');
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
