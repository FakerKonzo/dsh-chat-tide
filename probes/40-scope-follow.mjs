// 作用域四种模式：跟随 dsh-qqbot / 指定工作区 / 指定会话 / 关闭
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const prefsFile = join(CACHE, 'probe-scope-follow-prefs.json');
const PEER = 'PEER0000000000000000000000000001';
writeFileSync(prefsFile, JSON.stringify({ sessionIds: { ['qqbot:10000:group:' + PEER]: 'qq-session' } }));
process.env.CM_QQ_PREFS = prefsFile;

const { resolveSession } = await import('../lib/scope.js');
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const CWD = '/work/qq';
const follow = { mode: 'follow', followCwd: CWD };

// 跟随 = 仅 QQ 会话，不揽本地会话
ok(resolveSession({ id: 'qq-session' }, follow)?.adapter === 'qq', '跟随：QQ 会话纳入');
ok(resolveSession({ id: 'local-1', cwd: CWD }, follow) === null, '跟随：同工作区本地会话也不纳入');
ok(resolveSession({ id: 'local-2', cwd: '/elsewhere' }, follow) === null, '跟随：别的工作区不纳入');

// 工作区 = 该工作区内所有会话，QQ 与本地都算
ok(resolveSession({ id: 'local-1', cwd: CWD }, { mode: 'workspace', cwd: CWD })?.adapter === 'local', '工作区：本地会话纳入');
ok(resolveSession({ id: 'qq-session', cwd: CWD }, { mode: 'workspace', cwd: CWD })?.adapter === 'qq', '工作区：QQ 会话也纳入', JSON.stringify(resolveSession({ id: 'qq-session', cwd: CWD }, { mode: 'workspace', cwd: CWD })));
ok(resolveSession({ id: 'local-1', cwd: '/other' }, { mode: 'workspace', cwd: CWD }) === null, '工作区：别的不命中');

ok(resolveSession({ id: 'picked', cwd: '/x' }, { mode: 'sessions', sessionIds: ['picked'] })?.adapter === 'local', '会话：点名的纳入');
ok(resolveSession({ id: 'other', cwd: '/x' }, { mode: 'sessions', sessionIds: ['picked'] }) === null, '会话：没点名的不纳入');
ok(resolveSession({ id: 'qq-session' }, { mode: 'sessions', sessionIds: [] }) === null, '会话模式不再顺带纳入 QQ 会话');

ok(resolveSession({ id: 'qq-session' }, { mode: 'off' }) === null, '关闭：什么都不纳入');
ok(resolveSession({ id: 'local-1', cwd: CWD }, { mode: 'all' })?.adapter === 'local', 'all 仍可用（仅代码保留，不进设置页）');

rmSync(prefsFile, { force: true });
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
