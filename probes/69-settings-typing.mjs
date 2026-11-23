// 保存层的类型判断：新字段不该再被当成数字
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { setOverride, getOverrides } from '../lib/settings.js';

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(CACHE, { recursive: true });
const FILE = join(CACHE, 'probe-settings-typing.db');
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) rmSync(f, { force: true });
const db = openDatabase(FILE);

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 文本字段：正是之前存不下来的三个
ok(setOverride(db, 'owner.ids', 'OPENID_A,OPENID_B').ok, 'owner.ids 存得下');
ok(setOverride(db, 'persona.text', '说话简短一点').ok, 'persona.text 存得下');
ok(setOverride(db, 'persona.mode', 'custom').ok, 'persona.mode 存得下');
const o = getOverrides(db);
ok(o['owner.ids'] === 'OPENID_A,OPENID_B', 'owner.ids 读回是字符串', typeof o['owner.ids']);
ok(o['persona.text'] === '说话简短一点', 'persona.text 读回是原文');
ok(o['persona.mode'] === 'custom', 'persona.mode 读回是字符串');

// 2) 下拉只收声明里的取值
ok(!setOverride(db, 'persona.mode', 'somehow').ok, '未知下拉值被拒');
ok(!setOverride(db, 'scope.mode', 'nonsense').ok, '作用域未知值被拒');

// 3) 数字字段仍然校验范围
ok(!setOverride(db, 'routing.maxWakesPerDay', 'abc').ok, '数字字段仍拒绝非数字');
ok(!setOverride(db, 'routing.maxWakesPerDay', '-5').ok, '数字字段仍校验下限');
ok(setOverride(db, 'routing.maxWakesPerDay', '30').ok, '合法数字仍可写');
ok(getOverrides(db)['routing.maxWakesPerDay'] === 30, '数字读回是数字');

// 4) 布尔字段
ok(setOverride(db, 'extract.enabled', '0').ok && getOverrides(db)['extract.enabled'] === false, '布尔写 0 读回 false');

// 5) 时间字段格式
ok(!setOverride(db, 'routing.quietStart', '25:99').ok, '时间格式仍被校验');
ok(setOverride(db, 'routing.quietStart', '23:30').ok, '合法时间可写');
ok(getOverrides(db)['routing.quietStart'] === '23:30', '时间读回原值');

// 6) 未知键
ok(!setOverride(db, 'nope.nope', '1').ok, '未知键被拒');

db.close();
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
