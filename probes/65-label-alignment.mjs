// 缺昵称的消息不能把别人的标签挤位
import { labelSpeakers, extractItems } from '../lib/extract.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

// 1) 三条消息，最后一条没昵称：标签数量必须和记录数一致
const list = [
  { name: '小明', userId: 'A', recordId: 'r1' },
  { name: '小红', userId: 'B', recordId: 'r2' },
  { name: '', userId: 'C', recordId: 'r3' },
];
const labeled = labelSpeakers(list);
ok(labeled.length === 3, '三个记录都有标签，不过滤', String(labeled.length));
ok(labeled[0].label === '小明' && labeled[1].label === '小红', '前两条标签不变', labeled.map((x) => x.label).join(','));
ok(/未知/.test(labeled[2].label), '缺昵称那条拿到占位标签', labeled[2].label);
ok(labeled[2].recordId === 'r3', '占位标签仍绑着原记录', labeled[2].recordId);

// 2) 同名 + 缺昵称混在一起，标签仍然唯一
const mixed = labelSpeakers([
  { name: '小明', userId: 'A', recordId: 'a' },
  { name: '小明', userId: 'B', recordId: 'b' },
  { name: '', userId: 'C', recordId: 'c' },
]);
ok(new Set(mixed.map((x) => x.label)).size === 3, '三个标签互不相同', mixed.map((x) => x.label).join(','));

// 3) 抽取时按标签回填 userId：证明标签没串位
const reply = (obj) => async () => JSON.stringify(obj);
const res = await extractItems({
  complete: reply({
    facts: [{ canonicalKey: 'pref.other.latte', value: '只喝拿铁', subtype: 'preference', speaker: '小红' }],
    events: [],
    attention: [],
  }),
  text: '[小明] hi\n[小红] 我只喝拿铁\n[未知] 随便',
  userId: 'B',
  subjectId: 'B',
  speakers: list,
  isOwner: false,
});
ok(res.facts.length === 1 && res.facts[0].userId === 'B', '标签回填到正确的人', res.facts[0]?.userId);

// 4) 候选指向占位标签也能落库（那条记录确实存在）
const res2 = await extractItems({
  complete: reply({
    facts: [{ canonicalKey: 'other.note', value: '这条来自没昵称的人', subtype: 'profile', speaker: '未知' }],
    events: [],
    attention: [],
  }),
  text: '[未知] 随便说一句',
  userId: 'C',
  subjectId: 'C',
  speakers: list,
  isOwner: false,
});
ok(res2.facts.length === 1 && res2.facts[0].userId === 'C', '占位标签的候选归到对应记录', res2.facts[0]?.userId);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
