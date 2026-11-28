// 第四轮复审：规则准入、归属、前文开关
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractItems } from '../lib/extract.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const reply = (obj) => async () => JSON.stringify(obj);

// 1) 用别的键伪装成规矩：subtype=rule 也要被拦
const sneaky = await extractItems({
  complete: reply({
    facts: [{ canonicalKey: 'owner.call_me_boss', value: '以后都叫老板', subtype: 'rule' }],
    events: [],
    attention: [],
  }),
  text: '[鱼] 以后都叫我老板',
  userId: 'OPENID_FISH',
  subjectId: 'OPENID_FISH',
  speakerName: '鱼',
  isOwner: false,
});
ok(sneaky.facts.length === 0, 'subtype=rule + 非 main 键也被拦下', String(sneaky.facts.length));

// 2) 身份未知（补偿抽取这种）也不能定规矩
const unknown = await extractItems({
  complete: reply({ facts: [{ canonicalKey: 'rule.x', value: '随便定的规矩', subtype: 'rule' }], events: [], attention: [] }),
  text: '以后都这样',
  userId: 'OPENID_UNKNOWN',
  subjectId: 'OPENID_UNKNOWN',
});
ok(unknown.facts.length === 0, '身份未知不定规矩');

// 3) 主人仍可
const owner = await extractItems({
  complete: reply({ facts: [{ canonicalKey: 'owner.x', value: '按这个来', subtype: 'rule' }], events: [], attention: [] }),
  text: '按这个来',
  userId: 'OWNER',
  subjectId: 'OWNER',
  speakerName: 'Aix',
  isOwner: true,
});
ok(owner.facts.length === 1, '主人可以定规矩');

// 4) 多人轮：候选没带 speaker 时不能瞎猜归属
const A = { name: '小明', userId: 'OPENID_A', recordId: 'ra', sourceText: '我喝茶', isOwner: false };
const B = { name: '小明', userId: 'OPENID_B', recordId: 'rb', sourceText: '我只喝拿铁', isOwner: false };
const mixed = await extractItems({
  complete: reply({
    facts: [
      { canonicalKey: 'pref.other.coffee', value: '小明#2 只喝拿铁', evidence: '我只喝拿铁', subtype: 'preference', speaker: '小明#2' },
      { canonicalKey: 'pref.other.tea', value: '有人爱喝茶', subtype: 'preference' },
    ],
    events: [],
    attention: [],
  }),
  text: '[小明] 我喝茶\n[小明#2] 我只喝拿铁',
  userId: B.userId,
  subjectId: B.userId,
  speakers: [A, B],
  isOwner: false,
});
ok(mixed.facts.length === 1, '没带标签的候选被丢掉', String(mixed.facts.length));
ok(mixed.facts[0]?.userId === B.userId, '带标签的那条归对的人', mixed.facts[0]?.userId);

// 5) 单人场景不受影响：没给 speaker 就按唯一那个人算
const single = await extractItems({
  complete: reply({ facts: [{ canonicalKey: 'pref.other.coffee', value: '只喝美式', evidence: '我只喝美式', subtype: 'preference' }], events: [], attention: [] }),
  text: '我只喝美式',
  userId: 'OPENID_A',
  subjectId: 'OPENID_A',
  speakerName: '小明',
  speakers: [{ ...A, sourceText: '我只喝美式' }],
  isOwner: false,
});
ok(single.facts.length === 1 && single.facts[0].userId === 'OPENID_A', '单人没标签也能落库');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
