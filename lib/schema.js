// 设置页前后端对齐：可改键清单 + 默认值，单一来源
// 页面(api/settings)与后端(effectiveView)都读这里，避免键名漂移。

export const DEFAULTS = Object.freeze({
  'scope.mode': 'follow',
  'scope.cwd': '',
  'scope.sessionIds': '',
  'scope.includeSubagents': false,

  'features.routing': false,
  'features.contextInject': false,
  'features.ingest': true,
  'features.writePipeline': true,
  'features.writeTools': false,
  'features.tools': true,

  'routing.ambientReplyProbability': 0.1,
  'routing.attentionThreshold': 0.48,
  'routing.attentionMargin': 0.03,
  'routing.high': 0.55,
  'routing.low': 0.42,
  'routing.margin': 0.02,
  'routing.l2Threshold': 0.45,
  'routing.exemplarThreshold': 0.5,
  'routing.budget': 1000,
  'routing.maxWakesPerDay': 20,
  'routing.minWakeIntervalMinutes': 10,
  'routing.quietEnabled': false,
  'routing.quietStart': '00:00',
  'routing.quietEnd': '08:00',
  'routing.ftsRescue': true,
  'routing.llmFallback': true,

  'attention.enabled': true,
  'attention.maxActive': 80,
  'attention.ttlDays': 30,

  'owner.ids': '',
  'preset.enabled': false,
  'persona.mode': 'off',
  'persona.text': '',
  'context.maxChars': 1200,
  'context.ruleMaxChars': 5000,
  'context.eventLimit': 5,
  'context.eventRelatedReserve': 2,
  'context.eventMaxChars': 600,
  'context.recentDays': 7,
  'context.stripReasoning': true,
  'context.unifySessions': false,
  'context.groupExcludePrivate': true,

  'extract.enabled': true,
  'extract.storeFacts': true,
  'extract.storeEvents': true,
  'extract.storeAttention': true,
  'egress.hideToolErrors': true,
  'diagnostics.injectLog': true,
  'retention.rawLogDays': 0,
});

// [min, max] for numbers
export const RANGES = Object.freeze({
  'routing.ambientReplyProbability': [0, 1],
  'routing.attentionThreshold': [0, 1],
  'routing.attentionMargin': [0, 0.5],
  'routing.high': [0, 1],
  'routing.low': [0, 1],
  'routing.margin': [0, 1],
  'routing.l2Threshold': [0, 1],
  'routing.exemplarThreshold': [0, 1],
  'routing.budget': [0, 100000],
  'routing.maxWakesPerDay': [0, 500],
  'routing.minWakeIntervalMinutes': [0, 1440],
  'attention.maxActive': [1, 500],
  'attention.ttlDays': [1, 365],
  'context.maxChars': [100, 8000],
  'context.ruleMaxChars': [200, 8000],
  'context.eventLimit': [1, 20],
  'context.eventRelatedReserve': [0, 10],
  'context.eventMaxChars': [200, 8000],
  'context.recentDays': [1, 90],
  'janitor.intervalMinutes': [1, 1440],
  'retention.rawLogDays': [0, 3650],
});

/** 页面上的分组与文案（一次改全）。 */
export const GROUPS = Object.freeze([
  // ── 日常：一页做完的事 ──
  freezeGroup(
    ['日常', 'Everyday'],
    [
      '这几项决定它在哪些聊天里工作、记不记事、回答时带不带记忆。改完五秒内生效',
      'What Tide does in your chats: where it works, whether it remembers, and whether memories reach an answer',
    ],
    [
      ['scope.mode', ['在哪些聊天里使用', 'Which chats'], 'select', ['follow', 'workspace', 'sessions', 'off'], null, {
        labels: {
          follow: ['仅 QQ 会话（跟随 QQBot）', 'QQ sessions only'],
          workspace: ['整个工作区（含本地会话）', 'Whole workspace (local too)'],
          sessions: ['指定会话', 'Chosen chats'],
          off: ['关闭', 'Off'],
        },
      }],
      ['scope.cwd', ['工作区路径', 'Workspace path'], 'text', null, [['scope.mode', 'workspace']]],
      ['scope.sessionIds', ['选中的聊天', 'Chosen chats'], 'sessions', null, [['scope.mode', 'sessions']]],

      ['extract.enabled', ['自动记事', 'Remember automatically'], 'bool', null, null, {
        hint: [
          '关掉后暂停整理新记忆，原始聊天记录仍会保留',
          'Off pauses new memories; raw chat logs are still kept',
        ],
      }],
      ['extract.storeFacts', ['记录事实', 'Store facts'], 'bool', null, [['extract.enabled', true]]],
      ['extract.storeEvents', ['记录经历', 'Store events'], 'bool', null, [['extract.enabled', true]]],
      ['extract.storeAttention', ['记录关注点', 'Store attention'], 'bool', null, [['extract.enabled', true]]],

      ['features.contextInject', ['回答前自动找记忆', 'Look up memory before answering'], 'bool'],
      ['context.unifySessions', ['也用其他聊天的记忆', 'Use memories from other chats too'], 'bool', null, [['features.contextInject', true]]],
      ['context.groupExcludePrivate', ['群聊自动找记忆时跳过私聊内容', 'Skip private-chat memories in groups'], 'bool', null, [['features.contextInject', true], ['context.unifySessions', true]]],

      ['features.routing', ['群里按需接话', 'Join group chats when it makes sense'], 'bool'],
    ],
  ),

  // ── 机器人：它听谁的、它怎么说话 ──
  freezeGroup(
    ['机器人', 'Your bot'],
    [
      '它的身份和语气。身份决定谁的话能变成规矩；语气留空时完全交给工作区文档',
      'Who it listens to and how it sounds. Identity decides whose words can become rules; empty tone falls back to your workspace docs',
    ],
    [
      ['owner.ids', ['谁可以给机器人定规矩', 'Who can set rules'], 'owner'],
      ['persona.mode', ['机器人怎么说话', 'How it sounds'], 'select', ['off', 'custom'], null, {
        labels: {
          off: ['跟随工作区文档', 'Follow workspace docs'],
          custom: ['使用下面这段文本', 'Use the text below'],
        },
      }],
      ['persona.text', ['自定义人设文本', 'Custom persona'], 'text', null, [['persona.mode', 'custom']]],
    ],
  ),

  // ── 更多：用户偶尔会想调的 ──
  freezeGroup(
    ['更多设置', 'More'],
    [
      '安静时段和接话频率。机器人被叫醒后仍可能选择不回，所以这里是"尝试"的次数',
      'Quiet hours and how often it may try. A woken assistant may still stay silent, so these count attempts',
    ],
    [
      ['routing.quietEnabled', ['安静时段', 'Quiet hours'], 'bool'],
      ['routing.quietStart', ['从', 'From'], 'time', null, [['routing.quietEnabled', true]]],
      ['routing.quietEnd', ['到', 'Until'], 'time', null, [['routing.quietEnabled', true]]],
      ['routing.maxWakesPerDay', ['每天最多尝试主动接话几次', 'Attempts per day'], 'num'],
      ['routing.minWakeIntervalMinutes', ['两次试探至少间隔（分钟）', 'Minutes between attempts'], 'num'],
    ],
    { collapsible: true, defaultOpen: false },
  ),

  // ── 高级：调参，默认整块隐藏 ──
  freezeGroup(
    ['高级参数', 'Advanced'],
    [
      '这些改动会直接影响接话判断和注入量。默认不用动；出问题时再用',
      'These change how waking is judged and how much is injected. Leave them alone unless you are tuning or debugging',
    ],
    [
      ['attention.enabled', ['关注点判断', 'Attention matching'], 'bool'],
      ['routing.llmFallback', ['灰区交模型判断', 'Ask the model in the grey zone'], 'bool'],
      ['routing.attentionThreshold', ['关注点命中阈值', 'Attention hit threshold'], 'num'],
      ['routing.attentionMargin', ['关注点区分度', 'Attention gap'], 'num'],
      ['routing.ambientReplyProbability', ['探索概率', 'Exploration chance'], 'num'],
      ['routing.high', ['高位阈值', 'High threshold'], 'num'],
      ['routing.low', ['低位阈值', 'Low threshold'], 'num'],
      ['routing.margin', ['判定区分度', 'Decision gap'], 'num'],
      ['routing.l2Threshold', ['事实层门槛', 'Fact-layer floor'], 'num'],
      ['context.recentDays', ['近期窗口（天）', 'Recent window (days)'], 'num'],
      ['context.eventLimit', ['每轮经历条数', 'Events per turn'], 'num'],
      ['context.eventRelatedReserve', ['其中给相关经历的预留', 'Reserved for related hits'], 'num'],
      ['context.eventMaxChars', ['经历字符上限', 'Event character cap'], 'num'],
      ['context.maxChars', ['事实块字符上限', 'Fact block characters'], 'num'],
      ['context.ruleMaxChars', ['规则块字符上限', 'Rule block characters'], 'num'],
      ['context.stripReasoning', ['不回放上轮思考', 'Do not replay past reasoning'], 'bool'],
      ['egress.hideToolErrors', ['群里隐藏工具原始报错', 'Hide raw tool errors in groups'], 'bool'],
      ['diagnostics.injectLog', ['注入日志', 'Injection log'], 'bool'],
    ],
    { advanced: true },
  ),
]);

/** 一个字段在当前取值下是否该显示。条件写在 when 里，支持多个条件（全满足才显示）。 */
export function fieldVisible(field, values) {
  const when = field?.[4];
  if (!when) return true;
  const pairs = Array.isArray(when[0]) ? when : [when];
  return pairs.every(([key, expected]) => String(values?.[key]) === String(expected));
}

function freezeGroup(title, hint, fields, opts = {}) {
  return Object.freeze({
    title,
    hint,
    advanced: opts.advanced === true,
    collapsible: opts.collapsible === true,
    defaultOpen: opts.defaultOpen !== false,
    fields: Object.freeze(fields.map((f) => Object.freeze(f))),
  });
}

/** 所有允许的键 -> 类型 */
export function keyTypes() {
  const map = new Map();
  for (const key of Object.keys(DEFAULTS)) map.set(key, typeof DEFAULTS[key]);
  for (const key of Object.keys(RANGES)) map.set(key, 'number');
  return map;
}
