// 纯图片消息：不参与相关性判定、抽取跳过、被 @ 时提示先看图
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/db.js';
import { isImageOnly, looksMemorable } from '../lib/prefilter.js';

rmSync(fileURLToPath(new URL('../.cache/probe-image-only.db', import.meta.url)), { force: true });
let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const OPENID = 'AAAA0000BBBB1111CCCC2222DDDD3333';
const ENVELOPE = `[小明 (${OPENID})] <@EEEE4444FFFF5555AAAA6666BBBB7777>`;

ok(isImageOnly('- Image: C:/x/a.jpg'), '裸图片占位');
ok(isImageOnly(`${ENVELOPE} - Image: C:/x/a.jpg`), '带信封与 @ 的图片');
ok(isImageOnly(`${ENVELOPE} - Image: C:/x/a.jpg (@you)`), '带 (@you) 的图片');
ok(!isImageOnly(`${ENVELOPE} 这张怎么样\n- Image: C:/x/a.jpg`), '图片带文字不算纯图片');
ok(!isImageOnly('今天吃了三个饼'), '普通消息不算图片');
ok(!isImageOnly(''), '空消息');

// 抽取预筛：纯图片不该调模型
ok(looksMemorable('- Image: C:/x/a.jpg') === false, '纯图片不做抽取');
ok(looksMemorable(`${ENVELOPE} - Image: C:/x/a.jpg`) === false, '带信封的纯图片不做抽取');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
