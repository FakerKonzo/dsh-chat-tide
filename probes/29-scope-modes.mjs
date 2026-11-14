// 作用域模式自测：off/all/qq/sessions/subagent/allowlist
// 自带一份临时 QQ 映射，避免依赖本机 ~/.dsh-qqbot/model-prefs.json
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const prefsFile = join(CACHE, 'probe-qq-prefs.json');
const PEER = 'PEER0000000000000000000000000001';
writeFileSync(
  prefsFile,
  JSON.stringify({ sessionIds: { ['qqbot:10000:group:' + PEER]: 'session-group' } }),
);
process.env.CM_QQ_PREFS = prefsFile;

const { resolveSession, readQqBindings } = await import('../lib/scope.js');

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const qq = readQqBindings();
const qqEntry = [...qq.entries()][0];
ok(!!qqEntry, '能读到 QQ 会话映射', String(qq.size));

const sessionId = qqEntry?.[0] ?? 'session-1';
const peer = qqEntry?.[1]?.peerId ?? 'peer';

ok(resolveSession({ id: sessionId }, { mode: 'off' }) === null, 'off 不介入');
const qqBind = resolveSession({ id: sessionId }, { mode: 'qq' });
ok(qqBind?.adapter === 'qq', 'qq 模式绑定 QQ 会话');
ok(resolveSession({ id: 'local-x', cwd: '/tmp' }, { mode: 'qq' }) === null, 'qq 模式不碰本地会话');

const localBind = resolveSession({ id: 'local-x', cwd: '/tmp' }, { mode: 'all' });
ok(localBind?.adapter === 'local', 'all 模式接管本地会话');

const manual = resolveSession({ id: 'manual-1', cwd: '/tmp' }, { mode: 'sessions', sessionIds: ['manual-1'] });
ok(manual?.adapter === 'local', 'sessions 模式手动会话');
ok(resolveSession({ id: 'manual-2' }, { mode: 'sessions', sessionIds: ['manual-1'] }) === null, '未点名的会话不介入');
ok(resolveSession({ id: 'manual-3' }, { mode: 'off', sessionIds: ['manual-3'] }) === null, 'off 是总闸，点名也不生效');

ok(resolveSession({ id: 'sub-1', origin: 'subagent' }, { mode: 'all' }) === null, '子代理默认跳过');
ok(resolveSession({ id: 'sub-1', origin: 'subagent' }, { mode: 'all', includeSubagents: true })?.adapter === 'local', '可显式包含子代理');

const allow = resolveSession({ id: sessionId }, { mode: 'allowlist', peers: [peer] });
ok(allow?.adapter === 'qq', 'allowlist 命中');
ok(resolveSession({ id: sessionId }, { mode: 'allowlist', peers: ['nope'] }) === null, 'allowlist 未命中');

try { rmSync(prefsFile, { force: true }); } catch {}
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
