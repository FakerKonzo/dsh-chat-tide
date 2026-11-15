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

  'context.maxChars': 1200,
  'context.ruleMaxChars': 5000,
  'context.eventLimit': 5,
  'context.eventMaxChars': 600,
  'context.recentDays': 7,
  'context.unifySessions': false,
  'context.groupExcludePrivate': true,

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
  'context.eventMaxChars': [200, 8000],
  'context.recentDays': [1, 90],
  'janitor.intervalMinutes': [1, 1440],
  'retention.rawLogDays': [0, 3650],
});

/** 页面上的分组与文案（一次改全）。 */
export const GROUPS = Object.freeze([
  freezeGroup(
    ['作用域', 'Scope'],
    ['哪些会话归它管。默认跟随 dsh-qqbot：QQ 会话 + 同一工作区的本地会话；私聊不参与接茬判定，只要在作用域内就照常注入', 'Which conversations it manages. Default follows dsh-qqbot: QQ sessions plus local sessions in the same workspace. Private chats are never screened for waking; if in scope they still get memory injected'],
    [
      ['scope.mode', ['作用域', 'Scope'], 'select', ['follow', 'workspace', 'sessions', 'off']],
      ['scope.cwd', ['工作区路径', 'Workspace path'], 'text'],
      ['scope.sessionIds', ['会话 id（逗号分隔）', 'Session ids (comma separated)'], 'text'],
      ['scope.includeSubagents', ['包含子代理', 'Include subagents'], 'bool'],
    ],
  ),
    freezeGroup(['开关', 'Switches'], ['第 1–7 步的闸门：关掉哪一步，那一步就不再生效', 'Gates for steps 1-7: disabling one removes that stage'], [
    ['features.routing', ['群聊初筛', 'Group screening'], 'bool'],
    ['features.contextInject', ['上下文注入', 'Context injection'], 'bool'],
    ['context.unifySessions', ['统一会话', 'Unify sessions'], 'bool'],
    ['context.groupExcludePrivate', ['群聊屏蔽私聊来源', 'Keep private facts out of groups'], 'bool'],
    ['attention.enabled', ['关注点闸门', 'Attention gate'], 'bool'],
    ['routing.llmFallback', ['灰区交模型判断', 'Ask the model in the grey zone'], 'bool'],
    ['extract.storeFacts', ['写入事实', 'Store facts'], 'bool'],
    ['extract.storeEvents', ['写入经历', 'Store events'], 'bool'],
    ['extract.storeAttention', ['写入关注点', 'Store attention'], 'bool'],
    ['egress.hideToolErrors', ['群聊里隐藏工具原始报错', 'Hide raw tool errors in groups'], 'bool'],
    ['diagnostics.injectLog', ['注入日志', 'Injection log'], 'bool'],
  ]),
freezeGroup(['接茬判定', 'Waking'], ['第 3 步：什么消息值得我开口，以及开口的频率', 'Step 3: what is worth answering, and how often'], [
    ['routing.attentionThreshold', ['关注点命中阈值', 'Attention hit threshold'], 'num'],
    ['routing.attentionMargin', ['关注点区分度（与第二名的差距）', 'Attention gap over runner-up'], 'num'],
    ['routing.ambientReplyProbability', ['探索概率（不在关注点内）', 'Exploration chance (outside attention)'], 'num'],
    ['routing.high', ['高位阈值', 'High threshold'], 'num'],
    ['routing.low', ['低位阈值', 'Low threshold'], 'num'],
    ['routing.margin', ['判定区分度（与第二名的差距）', 'Decision gap over runner-up'], 'num'],
    ['routing.l2Threshold', ['事实层门槛', 'Fact-layer floor'], 'num'],
    ['routing.maxWakesPerDay', ['每日上限', 'Daily cap'], 'num'],
    ['routing.minWakeIntervalMinutes', ['最小间隔（分）', 'Minimum gap (minutes)'], 'num'],
    ['routing.quietEnabled', ['静默时段', 'Quiet hours'], 'bool'],
    ['routing.quietStart', ['静默开始', 'Quiet from'], 'text'],
    ['routing.quietEnd', ['静默结束', 'Quiet until'], 'text'],
  ]),
  freezeGroup(['注入窗口', 'Injection budget'], ['第 4 步：每轮往上下文里放多少规则、事实和经历', 'Step 4: how much rule, fact and event text goes into each turn'], [
    ['context.recentDays', ['近期窗口（天）', 'Recent window (days)'], 'num'],
    ['context.eventLimit', ['经历条数', 'Events per turn'], 'num'],
    ['context.eventMaxChars', ['经历字符上限', 'Event character cap'], 'num'],
    ['context.maxChars', ['事实块字符', 'Fact block characters'], 'num'],
    ['context.ruleMaxChars', ['规则块字符', 'Rule block characters'], 'num'],
  ]),
]);

function freezeGroup(title, hint, fields) {
  return Object.freeze({ title, hint, fields: Object.freeze(fields.map((f) => Object.freeze(f))) });
}

/** 所有允许的键 -> 类型 */
export function keyTypes() {
  const map = new Map();
  for (const key of Object.keys(DEFAULTS)) map.set(key, typeof DEFAULTS[key]);
  for (const key of Object.keys(RANGES)) map.set(key, 'number');
  return map;
}
