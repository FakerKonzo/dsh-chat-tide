// 证据抽取：对话 → 稳定事实(facts) + 一次性经历(events) + 关注点(attention)。可注入 complete，离线可测。
export const EXTRACT_PROMPT = `你是记忆抽取器。从对话片段中抽取三类内容：
A 稳定事实 facts：长期有效的资料、偏好、关系、项目背景（如住哪、职业、口味偏好）。
B 一次性经历 events：今天/某时发生了什么、吃了什么、去了哪、做了什么（如"今天吃了三个饼""去杭州出差"）。
C 关注点 attention：只挑"以后聊到值得主动插一句"的主题（主人的重要进展、承诺、情绪、长期兴趣、正在做的事）。琐碎闲聊、路人话题、一次性吃喝都不进 attention。宁可少，不要滥。开发过程、插件实现、模型自身运作、我们讨论系统设计的内容一律不算关注点。label 必须能独立读懂（谁/什么），不能是"想玩但舍不得买"这种没对象的碎片。

规则：
1) 同一天发生的多件事是多个 events，不要合并，也不要判为互相矛盾。
2) 一次性的吃喝/出行/活动一律进 events，不要写成 facts。
3) facts 的 canonicalKey 用英文蛇形键，值要具体。命名空间（含主体）：主人属性 owner.*、别人属性 other.*、主人偏好 pref.owner.*、别人偏好 pref.other.*、主人待办 todo.owner.*、别人待办 todo.other.*、规矩 rule.*、助手自己 self.*、关系 rel.*。不要拿昵称当键——昵称会变。
4) 没有可抽的就返回空数组。
5) 值必须有明确对象：脱离上下文读不懂的碎片（"精修""晚上修一下""东西挺多"）一律不记；缺主语或缺宾语的不要写成事实。
6) value 只写事实本身：不要把计划、打算、做法混进去（"生日 9 月 18 日"就写日期，别写"打算提前记着"）；计划类用 subtype "todo"。
7) 关于助手自己的属性、计划、愿望（不是主人），subtype 用 "self"，entityId 固定写 "assistant"，不要记成主人的事实。
8) 证据等级：只有用户本人第一人称原话才算 human_explicit；转述可核的用 source_verifiable；你自己归纳、推测、总结的观点用 agent_inferred，不要冒充用户原话。
9) 规则类内容（主人的规矩、红线、口吻、流程）用 subtype "rule"，值写成能独立读懂的一条规矩，开头标明主题。
10) 严格输出 JSON 对象，不要解释：
{"facts":[{"canonicalKey":"","subtype":"profile|preference|todo|rule|relation|self","value":"","entityId":"可选，助手自己的事写 assistant","occurredAt":毫秒时间戳可选,"evidence":"原文片段"}],
 "events":[{"content":"一句概括","occurredAt":毫秒时间戳可选,"evidence":"原文片段"}],
 "attention":[{"label":"主题短句（中文，可被检索）","note":"为什么值得关注","weight":0.0-1.0}]}
11) attention 为空就返回 []。
12) 相对时间（今天/昨天/前天/上周）一律换算成具体日期再写：occurredAt 填毫秒时间戳，值里也写日期而不是「今天」。`;

function stripFence(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (m ? m[1] : text).trim();
}

function pickObject(body) {
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const FACT_SUBTYPES = new Set(['profile', 'preference', 'todo', 'rule', 'relation', 'self']);

/**
 * 解析抽取结果，兼容两种格式：
 * - 旧：顶层数组 → 全部当 facts
 * - 新：{ facts:[], events:[] }
 */
export function parseExtraction(raw) {
  const body = stripFence(String(raw ?? ''));

  if (body.startsWith('[')) {
    const end = body.lastIndexOf(']');
    if (end > 0) {
      try {
        const arr = JSON.parse(body.slice(0, end + 1));
        if (Array.isArray(arr)) return { facts: normalizeFacts(arr), events: [], attention: [] };
      } catch {
        /* 落到对象解析 */
      }
    }
  }

  const parsed = pickObject(body);
  if (parsed && (Array.isArray(parsed.facts) || Array.isArray(parsed.events) || Array.isArray(parsed.attention))) {
    return {
      facts: normalizeFacts(Array.isArray(parsed.facts) ? parsed.facts : []),
      events: normalizeEvents(Array.isArray(parsed.events) ? parsed.events : []),
      attention: normalizeAttention(parsed.attention),
    };
  }
  return { facts: [], events: [], attention: [] };
}

function normalizeAttention(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a.label === 'string' && a.label.trim())
    .slice(0, 8)
    .map((a) => ({
      label: a.label.trim().slice(0, 60),
      note: typeof a.note === 'string' ? a.note.trim().slice(0, 200) : undefined,
      weight: Number.isFinite(a.weight) ? Math.max(0, Math.min(1, a.weight)) : 0.5,
    }));
}

function normalizeFacts(list) {
  return list
    .filter((c) => c && typeof c.canonicalKey === 'string' && c.canonicalKey && typeof c.value === 'string' && c.value)
    .map((c) => ({
      canonicalKey: c.canonicalKey,
      subtype: FACT_SUBTYPES.has(c.subtype) ? c.subtype : 'profile',
      value: c.value,
      entityId: typeof c.entityId === 'string' ? c.entityId : undefined,
      occurredAt: Number.isFinite(c.occurredAt) ? c.occurredAt : undefined,
      evidence: typeof c.evidence === 'string' ? c.evidence : undefined,
      speaker: typeof c.speaker === 'string' ? c.speaker.trim().slice(0, 40) : undefined,
    }));
}

function isJunkEventContent(text) {
  const t = String(text ?? '');
  return (
    t.includes('Current runtime context') ||
    t.includes('Time sampled while preparing') ||
    t.includes('system-reminder') ||
    t.includes('The working directory changed')
  );
}

function normalizeEvents(list) {
  return list
    .filter((c) => c && typeof c.content === 'string' && c.content.trim() && !isJunkEventContent(c.content))
    .map((c) => ({
      content: c.content.trim().slice(0, 500),
      occurredAt: Number.isFinite(c.occurredAt) ? c.occurredAt : undefined,
      evidence: typeof c.evidence === 'string' ? c.evidence : undefined,
      speaker: typeof c.speaker === 'string' ? c.speaker.trim().slice(0, 40) : undefined,
    }));
}

/** 兼容旧调用：只要 facts。 */
export function parseCandidates(raw) {
  return parseExtraction(raw).facts;
}

/** 证据等级：第三方代述最高 source_verifiable；本人第一人称才算 human_explicit。 */
export function classifyTier({ text, assertedBy, subjectId }) {
  if (assertedBy && subjectId && assertedBy !== subjectId) return 'source_verifiable';
  if (/[我俺]|我自己|我的/.test(String(text ?? ''))) return 'human_explicit';
  return 'source_verifiable';
}

/**
 * 给同一轮的发言人分配唯一标签。昵称会重名（群里两个人叫一样），
 * 重名时退化成「昵称#2」，让模型能指到具体那一条消息。
 */
export function labelSpeakers(list) {
  const raw = (Array.isArray(list) ? list : []).filter((s) => s?.name);
  const count = new Map();
  for (const sp of raw) count.set(String(sp.name), (count.get(String(sp.name)) ?? 0) + 1);
  const seen = new Map();
  return raw.map((sp) => {
    const name = String(sp.name);
    if (count.get(name) === 1) return { ...sp, label: sp.label ?? name };
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return { ...sp, label: sp.label ?? (n === 1 ? name : `${name}#${n}`) };
  });
}

/** 跑一次抽取。返回 {facts:[], events:[]}；模型失败/格式坏 → 两个空数组（不抛）。 */
export async function extractItems({
  complete,
  text,
  userId,
  subjectId,
  assertedBy,
  sourceRecordId,
  scope = null,
  speakerName = null,
  isOwner = null,
  // 一轮里有多个发言人时传进来：[{ name, userId, recordId, isOwner }]
  speakers = null,
  // 文本里带【前文】时置 true：前文只用来解指代，不从里面抽东西
  hasPriorContext = false,
  now = Date.now(),
}) {
  const empty = { facts: [], events: [], attention: [] };
  if (!text || String(text).trim().length < 2) return empty;

  // 多人同轮：把「这段话是谁说的」交给模型按行绑定，不再整段归给最后一个人
  const speakerList = Array.isArray(speakers) ? speakers.filter((s) => s?.name) : [];
  const multi = speakerList.length > 1;
  const named = labelSpeakers(speakerList);
  const byLabel = new Map(named.map((s) => [s.label, s]));
  // 重名时裸昵称指向第一条，避免模型只写昵称导致全部错配到最后一个人
  const byName = new Map();
  for (const s of named) if (!byName.has(String(s.name))) byName.set(String(s.name), s);
  const fallbackSpeaker = named.length ? named[named.length - 1] : null;

  const speakerFor = (item) => {
    const key = item?.speaker ? String(item.speaker).trim() : '';
    if (!key) return null;
    return byLabel.get(key) ?? byName.get(key) ?? null;
  };
  const speakerOf = (item) => speakerFor(item) ?? fallbackSpeaker ?? null;

  let raw;
  try {
    const who = multi
      ? `\n本段包含多人发言，每行以「[昵称]」开头：${named.map((s) => s.label).join('、')}。每条候选必须带 speaker 字段，值必须原样照抄行首的那个标签（重名时形如「小明#2」）。`
      : speakerName
        ? `\n本段说话人：${speakerName}${isOwner === true ? '（主人本人）' : '（不是主人，是群友或其他人）'}。`
        : '';
    const ownerRule = multi
      ? `\n13) 多人发言：按 speaker 分别归属。说话人是主人用 owner.* / pref.owner.* / todo.owner.*；不是主人用 other.* / pref.other.* / todo.other.*，且 value 的主语必须写该昵称，绝不能写「主人」。`
      : isOwner === true
        ? '\n13) 说话人是主人：用 owner.* / pref.owner.* / todo.owner.*，value 里可以写「主人」。'
        : speakerName
          ? `\n13) 说话人不是主人：属性用 other.*、偏好用 pref.other.*、待办用 todo.other.*，value 的主语必须写「${speakerName}」，绝不能写「主人」。`
          : '';
    const priorRule = hasPriorContext
      ? '\n【重要】输入分两段：【前文】只用来理解代词指代（我/他/你分别是谁），不要从【前文】里抽取任何事实或经历；只从【当前消息】里抽取。'
      : '';
    raw = await complete([
      {
        role: 'system',
        content: EXTRACT_PROMPT + who + ownerRule + priorRule + '\n当前日期：' + new Date(now).toISOString().slice(0, 10),
      },
      { role: 'user', content: String(text).slice(0, 4000) },
    ]);
  } catch {
    return empty;
  }
  const parsed = parseExtraction(raw);
  // 每条候选只拿自己那句文本来定证据等级，不再整段统一
  const tierOf = (item, sp) => {
    // 证据原句优先：它才是这句话真正的出处；没有才退回本条自己的文本
    const own = String(item?.evidence ?? item?.surface ?? item?.value ?? item?.content ?? '') || String(text ?? '');
    return classifyTier({ text: own, assertedBy: sp?.userId ?? assertedBy, subjectId: sp?.userId ?? subjectId });
  };
  const facts = parsed.facts.map((c) => {
    const sp = speakerOf(c);
    const uid = sp?.userId ?? userId;
    return {
      ...c,
      userId: uid,
      entityId: c.entityId ?? (c.subtype === 'self' ? 'assistant' : uid),
      assertedBy: sp?.userId ?? assertedBy ?? uid,
      subjectId: sp?.userId ?? subjectId ?? uid,
      speakerName: sp?.name ?? speakerName ?? null,
      provenanceTier: tierOf(c, sp),
      sourceRecordId: sp?.recordId ?? sourceRecordId,
      scope: scope ?? 'unknown',
      observedAt: now,
    };
  });
  const events = parsed.events.map((e) => {
    const sp = speakerOf(e);
    return {
      ...e,
      userId: sp?.userId ?? userId,
      speakerName: sp?.name ?? speakerName ?? null,
      sourceRecordId: sp?.recordId ?? sourceRecordId,
      observedAt: now,
      occurredAt: e.occurredAt ?? now,
    };
  });
  const attention = parsed.attention.map((a) => {
    const sp = speakerOf(a);
    return { ...a, userId: sp?.userId ?? userId, sourceRecordId: sp?.recordId ?? sourceRecordId };
  });
  return { facts, events, attention };
}

/** 兼容旧调用：只要 facts。 */
export async function extractCandidates(args) {
  const { facts } = await extractItems(args);
  return facts;
}
