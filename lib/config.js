// 插件配置（schemastery）。字段说明里标了「第 N 步」，对应 README 的消息处理流程。
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 数据库文件；留空默认 <数据目录>/memory.db（见 lib/const.js） */
  dbFile: z.string().default(''),
  /** 作用域：默认不介入任何会话（第 2 步） */
  scope: z.object({
    mode: z.union([z.const('off'), z.const('all'), z.const('qq'), z.const('allowlist'), z.const('workspace'), z.const('preset'), z.const('sessions'), z.const('follow')]).default('off'),
    peers: z.array(z.string()).default([]),
    /** preset 模式匹配的 agentPreset id 列表 */
    presets: z.array(z.string()).default([]),
    /** workspace 模式下匹配的会话工作目录 */
    cwd: z.string().default(''),
    /** 手动点名生效的会话 id（sessions 模式或附加在任何模式之上） */
    sessionIds: z.array(z.string()).default([]),
    /** 是否介入子代理会话，默认否 */
    includeSubagents: z.boolean().default(false),
  }),
  embedding: z.object({
    enabled: z.boolean().default(true),
    model: z.string().default('Xenova/bge-small-zh-v1.5'),
    dtype: z.string().default('q8'),
    cacheDir: z.string().default(''),
    /** HF 镜像，例如 https://hf-mirror.com；留空则用默认或环境变量 */
    remoteHost: z.string().default(''),
    /** 允许联网下载模型；关掉就只能用 cacheDir 里已有的 */
    allowRemote: z.boolean().default(true),
    /**
     * 允许退回主进程跑 ONNX。默认关：主进程一旦加载 onnxruntime，
     * 它的原生库就被占住，之后再卸载本插件会删不掉文件（升级会卡死）。
     */
    allowInline: z.boolean().default(false),
  }),
  features: z.object({
    /** 第 1 步：入站消息写流水账 */
    ingest: z.boolean().default(true),
    /** 第 6 步：轮末抽取事实/经历/关注点 */
    writePipeline: z.boolean().default(true),
    /** 静默时挂起正文（出站闸门） */
    egressGate: z.boolean().default(true),
    /** 是否向模型注册 memory_* / stay_silent / reply 工具 */
    tools: z.boolean().default(true),
    /** 是否开放写入类工具（memory_write_candidate / memory_forget） */
    writeTools: z.boolean().default(false),
    /** 只读状态页 /tide */
    statusPage: z.boolean().default(true),
    /** 第 4 步：是否把记忆注入上下文 */
    contextInject: z.boolean().default(false),
    /** 第 3 步：群聊没 @ 时是否走初筛（关掉=每条都进模型） */
    routing: z.boolean().default(false),
  }),
  egress: z.object({
    /** 静默时先挂起正文再决定（群聊建议开；私聊流式可关） */
    holdTextOnSilence: z.boolean().default(true),
    /**
     * 群聊里把工具失败的原始报错换成一句话。只改给模型看的文本，不影响工具真正失败这件事；
     * 私聊、本地会话、子代理都不动。
     */
    hideToolErrors: z.boolean().default(true),
  }),
  routing: z.object({
    /** 第 3 步 判定阈值：向量相似度高/低水位与 margin */
    high: z.number().min(0).max(1).default(0.55),
    low: z.number().min(0).max(1).default(0.42),
    margin: z.number().min(0).max(1).default(0.02),
    /** 灰区默认保守拒绝 */
    uncertainPolicy: z.union([z.const('reject'), z.const('wake')]).default('reject'),
    /** 灰区是否交模型判断（关掉省钱，误判会涨） */
    llmFallback: z.boolean().default(true),
    /** 关注点向量命中阈值：达到即直接唤醒 */
    attentionThreshold: z.number().min(0).max(1).default(0.48),
    /** 软区允许下探的幅度（配合区分度） */
    attentionSoftBand: z.number().min(0).max(0.3).default(0.05),
    /** 软区要求的最小区分度（top1 - top2） */
    attentionMargin: z.number().min(0).max(1).default(0.03),
    /** 探索概率：不在关注点范围内时，仍给一个小机会让它自己判断 */
    ambientReplyProbability: z.number().min(0).max(1).default(0.1),
    /** 事实层门槛：查询与事实向量的余弦下限 */
    l2Threshold: z.number().min(0).max(1).default(0.45),
    /** 灰区用关键词重叠救援（零 token） */
    ftsRescue: z.boolean().default(true),
    /** 诊断：该时间戳（epoch ms）之前强制唤醒，仅验证用 */
    forceWakeUntil: z.number().default(0),
    exemplarThreshold: z.number().min(0).max(1).default(0.5),
    /** 第 3 步预算：每天能花在判定上的 token 预算 */
    budget: z.number().min(1).max(100000).default(1000),
    /** 静默时段：到点不主动接茬（第 3 步） */
    quietEnabled: z.boolean().default(false),
    quietStart: z.string().default('00:00'),
    quietEnd: z.string().default('08:00'),
    /** 每天最多主动接茬几次；0 = 不限 */
    maxWakesPerDay: z.number().min(0).max(500).default(20),
    /** 两次接茬最小间隔（分钟）；0 = 不限 */
    minWakeIntervalMinutes: z.number().min(0).max(1440).default(10),
  }),
  context: z.object({
    enabled: z.boolean().default(false),
    /** 第 4 步：事实块字符上限 */
    maxChars: z.number().min(100).max(4000).default(1200),
    /** 第 4 步：规则块字符上限（规则常驻，单独预算） */
    // 规矩只在变化时才会被送进上下文（增量注入），所以预算给足，别让红线被挤掉
    ruleMaxChars: z.number().min(200).max(8000).default(5000),
    /** 第 4 步：一次注入多少条经历 */
    eventLimit: z.number().min(1).max(20).default(5),
    /** 第 4 步：经历块字符上限 */
    eventMaxChars: z.number().min(200).max(4000).default(600),
    /** 第 4 步：经历回溯窗口（天） */
    recentDays: z.number().min(1).max(90).default(7),
    /** 统一会话：同一用户的群聊/私聊共用一份记忆池 */
    unifySessions: z.boolean().default(false),
    /** 群聊注入时屏蔽只发生在私聊的内容（统一会话开启时才有意义） */
    groupExcludePrivate: z.boolean().default(true),
  }),
  attention: z.object({
    enabled: z.boolean().default(true),
    maxActive: z.number().min(1).max(500).default(80),
    ttlDays: z.number().min(1).max(365).default(30),
    /** 额外屏蔽词：命中的主题不记为关注点 */
    blockPatterns: z.array(z.string()).default([]),
  }).default({ enabled: true, maxActive: 80, ttlDays: 30 }),
  retention: z.object({
    /** 第 7 步：原始记录内容保留天数；0 = 不清理（只脱敏内容，审计信封保留） */
    rawLogDays: z.number().min(0).max(3650).default(0),
  }),
  janitor: z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().min(5).max(1440).default(30),
  }),
  extract: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    maxChars: z.number().min(100).max(8000).default(3000),
    /** 本轮文本短于该长度不调模型抽取 */
    minChars: z.number().min(0).max(500).default(6),
    /** 第 6 步：三类内容分别是否入库 */
    storeFacts: z.boolean().default(true),
    storeEvents: z.boolean().default(true),
    storeAttention: z.boolean().default(true),
  }),
  write: z.object({
    /** 每轮结束是否抽取；关掉就只入站镜像不写记忆 */
    extractOnTurnEnd: z.boolean().default(true),
    maxAttempts: z.number().min(1).max(5).default(3),
  }),
  diagnostics: z.object({
    /** 写 inject.log（注入诊断） */
    injectLog: z.boolean().default(true),
  }),
  logging: z.object({ level: z.union([z.const('debug'), z.const('info'), z.const('warn')]).default('info') }),
});
