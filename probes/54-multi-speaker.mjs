// 一轮多人发言：每条候选按来源消息归属，不再整段算给最后一个人
import { extractItems } from '../lib/extract.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

const A = { name: '阿甲', userId: 'OPENID_A', recordId: 'raw-a', isOwner: false };
const B = { name: '阿乙', userId: 'OPENID_B', recordId: 'raw-b', isOwner: false };

// 模型按 speaker 分别归属
const replyBoth = JSON.stringify({
  facts: [
    { canonicalKey: 'pref.other.coffee', value: '阿甲只喝美式', subtype: 'preference', speaker: '阿甲' },
    { canonicalKey: 'pref.other.coffee', value: '阿乙只喝拿铁', subtype: 'preference', speaker: '阿乙' },
  ],
  events: [
    { content: '阿甲说今天加班', speaker: '阿甲' },
    { content: '阿乙说周末去爬山', speaker: '阿乙' },
  ],
  attention: [],
});

const run = async (raw, opts) => {
  const items = await extractItems({
    complete: async () => raw,
    text: '[阿甲] 我只喝美式\n[阿乙] 我只喝拿铁',
    userId: B.userId,
    subjectId: B.userId,
    assertedBy: null,
    sourceRecordId: B.recordId,
    speakerName: B.name,
    speakers: [A, B],
    ...opts,
  });
  return items;
};

const both = await run(replyBoth);
ok(both.facts.length === 2, '两条事实都记下', String(both.facts.length));
const f1 = both.facts.find((f) => f.value.includes('阿甲'));
const f2 = both.facts.find((f) => f.value.includes('阿乙'));
ok(f1?.userId === A.userId, '阿甲那条归阿甲', f1?.userId);
ok(f2?.userId === B.userId, '阿乙那条归阿乙', f2?.userId);
ok(f1?.sourceRecordId === A.recordId, '证据指回阿甲那条原始记录');
ok(f2?.sourceRecordId === B.recordId, '证据指回阿乙那条原始记录');
ok(f1?.speakerName === '阿甲' && f2?.speakerName === '阿乙', '各自带上发言人');

const e1 = both.events.find((e) => e.content.includes('阿甲'));
const e2 = both.events.find((e) => e.content.includes('阿乙'));
ok(e1?.userId === A.userId && e2?.userId === B.userId, '经历也按人归属');
ok(e1?.speakerName === '阿甲' && e2?.speakerName === '阿乙', '经历带各自发言人');

// 模型没给 speaker：退回最后一位发言人（旧行为，不崩）
const noSpeaker = await run(
  JSON.stringify({ facts: [{ canonicalKey: 'k.a', value: '随便一句', subtype: 'profile' }], events: [], attention: [] }),
);
ok(noSpeaker.facts[0]?.userId === B.userId, '没给 speaker 时退回整段默认归属');

// speaker 给了不存在的名字：也退回默认，不丢条目
const unknown = await run(
  JSON.stringify({ facts: [{ canonicalKey: 'k.b', value: '又一句', subtype: 'profile', speaker: '查无此人' }], events: [], attention: [] }),
);
ok(unknown.facts[0]?.userId === B.userId, 'speaker 不在名单里就退回默认');

// 单人场景不受影响：不该出现多人提示
let seenSystem = '';
await extractItems({
  complete: async (messages) => {
    seenSystem = messages.find((m) => m.role === 'system')?.content ?? '';
    return JSON.stringify({ facts: [], events: [], attention: [] });
  },
  text: '[阿甲] 我只喝美式',
  userId: A.userId,
  subjectId: A.userId,
  speakerName: '阿甲',
});
ok(!seenSystem.includes('多人发言'), '单人时不加多人指令');
ok(seenSystem.includes('本段说话人：阿甲'), '单人仍带单数发言人');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
