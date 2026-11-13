// 注入来源范围：统一会话 / 群聊屏蔽私聊来源 的实际效果
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { writeFact } from '../lib/facts.js';
import { injectionScopes, selectFactsForInjection } from '../lib/context.js';

const FILE = fileURLToPath(new URL('../.cache/probe-inject-scopes.db', import.meta.url));
rmSync(FILE, { force: true });
for (const ext of ['-wal', '-shm']) rmSync(FILE + ext, { force: true });
const db = openDatabase(FILE);
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const base = { userId: 'U1', entityId: 'U1', assertedBy: 'U1', subjectId: 'U1', provenanceTier: 'human_explicit' };
const put = (key, value, scope) =>
  writeFact(db, { ...base, canonicalKey: key, subtype: 'profile', value, scope });

put('owner.from_group', '群里说过的项目', 'group');
put('owner.from_private', '私聊说过的地址', 'private');
put('owner.from_local', '本地工作区里的事', 'local');

const ids = ['U1'];

// 1) 默认：群聊不看私聊
const def = injectionScopes({ isGroup: true, cfg: {} });
ok(!def.includes('private'), '群聊默认排除私聊来源', JSON.stringify(def));
const defRows = selectFactsForInjection(db, { isGroup: true, speakerIds: ids, cfg: {} });
ok(!defRows.some((r) => r.canonicalKey === 'owner.from_private'), '群里取不到私聊事实');
ok(defRows.some((r) => r.canonicalKey === 'owner.from_group'), '群里能取到群聊事实');

// 2) 只开统一会话，但没关屏蔽：仍然不看私聊
const unifyOnly = injectionScopes({ isGroup: true, cfg: { unifySessions: true } });
ok(!unifyOnly.includes('private'), '只开统一会话仍受屏蔽约束', JSON.stringify(unifyOnly));

// 3) 只关屏蔽，没开统一会话：仍然不看私聊
const excludeOff = injectionScopes({ isGroup: true, cfg: { groupExcludePrivate: false } });
ok(!excludeOff.includes('private'), '只关屏蔽仍受统一会话约束', JSON.stringify(excludeOff));

// 4) 两个都放开：群聊可见私聊来源
const both = injectionScopes({ isGroup: true, cfg: { unifySessions: true, groupExcludePrivate: false } });
ok(both.includes('private'), '统一会话 + 关屏蔽后才带私聊来源', JSON.stringify(both));
const bothRows = selectFactsForInjection(db, { isGroup: true, speakerIds: ids, cfg: { unifySessions: true, groupExcludePrivate: false } });
ok(bothRows.some((r) => r.canonicalKey === 'owner.from_private'), '放开后群里能取到私聊事实');

// 5) 私聊：默认只看私聊来源，开统一会话后可见群聊来源
const c2cDefault = injectionScopes({ isGroup: false, cfg: {} });
ok(!c2cDefault.includes('group'), '私聊默认排除群聊来源', JSON.stringify(c2cDefault));
const c2cUnify = injectionScopes({ isGroup: false, cfg: { unifySessions: true } });
ok(c2cUnify.includes('group'), '私聊开统一会话后可见群聊来源', JSON.stringify(c2cUnify));

// 6) 群聊仍按发言人取，不把别人的事实混进来
writeFact(db, { ...base, userId: 'U2', entityId: 'U2', assertedBy: 'U2', subjectId: 'U2', canonicalKey: 'other.stranger', subtype: 'profile', value: '别人的事', scope: 'group' });
const bySpeaker = selectFactsForInjection(db, { isGroup: true, speakerIds: ids, cfg: { unifySessions: true, groupExcludePrivate: false } });
ok(!bySpeaker.some((r) => r.canonicalKey === 'other.stranger'), '群聊按发言人过滤');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
