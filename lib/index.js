// DSH 插件入口：Tide（记忆核心 + 出站闸门）
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Config } from './config.js';
import { openDatabase } from './db.js';
import { loadVec, ensureVecTables, putVector } from './vec.js';
import { createEmbedderManager } from './embed.js';
import { appendEvent, appendRawLog, deleteEvent } from './events.js';
import { deleteFact, getCandidates, getCurrentFact, writeFact } from './facts.js';
import { searchEvents, searchFacts } from './fts.js';
import { createEgress } from './egress.js';
import { parseSender, resolveSession } from './scope.js';
import { extractItems, labelSpeakers } from './extract.js';
import { isInjectedBlock, inboundBody, looksMemorable, isImageOnly } from './prefilter.js';
import { runRepairExtractions } from './repair.js';
import { addAttention, pruneAttention, attentionRowid, attentionVectorText, attentionNeedingVector } from './attention.js';
import { recordTopicCandidate, promoteCandidates } from './topics.js';
import { ROUTE, ROW_ID, defaultDbFile, ensureDataDir } from './const.js';
import { buildInjection, isMemoryBlock, memoryNodes, memoryText, retireMemoryNodes, stripReasoning, TIDE_MEMORY_SOURCE } from './inject.js';
import { renderRuleSection, renderPersonaSection } from './prompt.js';
import { registerChatPreset } from './preset.js';
import { ownerIdsFromQqbot } from './scope.js';
import { applyOverrides, getOverrides, settingsRevision } from './settings.js';
import { upsertPerson, canonicalKeyOf, nicknameOf } from './people.js';
import { extractImagePath, sha1OfFile, getCachedImage, putCachedImage, renderImageHint } from './images.js';
import { decideRoute } from './route-decision.js';
import { createStatusHandler } from './status-page.js';
import { createPluginHandler } from './api.js';
import { selectFacts, selectFactsForUsers, selectFactsForSpeakers, selectFactsForInjection, selectRuleFacts, renderFactBlock, renderRuleBlock, renderEventBlock } from './context.js';
import { runJanitor, backfillVectors } from './janitor.js';
import { classify, decideAmbient, actionFor, budgetGate } from './route.js';
import { classifyByLlm } from './llmroute.js';
import { pruneBudgets } from './budget.js';
import { createCircuit } from './circuit.js';
import { mergeCandidates } from './merge.js';
import { reapExpiredPolicies, setRoutePolicy } from './silence.js';
import { hideToolErrorDecision } from './scrub.js';

export const name = 'tide';
export const inject = ['tools'];
export { Config };

const isTaggedMemory = (message) => message?.role === 'user' && message.source?.kind === TIDE_MEMORY_SOURCE;
const textOut = (text) => [{ type: 'text', text }];
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

const output = (schema) => ({ schema, render: (_args, value) => textOut(JSON.stringify(value, null, 2)) });

export async function apply(ctx, config) {
  const cfg = {
    egress: { holdTextOnSilence: true, ...(config.egress ?? {}) },
    features: { ingest: true, writePipeline: true, egressGate: true, contextInject: false, routing: false, tools: true, ...(config.features ?? {}) },
    extract: { maxChars: 3000, ...(config.extract ?? {}) },
    context: {
      enabled: false,
      maxChars: 1200,
      ruleMaxChars: 5000,
      eventLimit: 5,
      eventRelatedReserve: 2,
      eventMaxChars: 600,
      recentDays: 7,
      unifySessions: false,
      groupExcludePrivate: true,
      ...(config.context ?? {}),
    },
    janitor: { enabled: true, intervalMinutes: 30, ...(config.janitor ?? {}) },
    retention: { rawLogDays: 0, ...(config.retention ?? {}) },
    routing: {
      high: 0.55,
      low: 0.42,
      margin: 0.02,
      uncertainPolicy: 'reject',
      budget: 1000,
      llmFallback: true,
      exemplarThreshold: 0.5,
      ftsRescue: true,
      ambientReplyProbability: 0.1,
      attentionThreshold: 0.5,
      attentionSoftBand: 0.05,
      attentionMargin: 0.04,
      quietEnabled: false,
      quietStart: '00:00',
      quietEnd: '08:00',
      maxWakesPerDay: 20,
      minWakeIntervalMinutes: 10,
      ...(config.routing ?? {}),
    },
    diagnostics: { injectLog: true, ...(config.diagnostics ?? {}) },
    attention: { enabled: true, maxActive: 80, ttlDays: 30, ...(config.attention ?? {}) },
    write: { maxAttempts: 3, ...(config.write ?? {}) },
    scope: config.scope ?? { mode: 'off', peers: [] },
  };
  if (config.enabled === false) return;

  ensureDataDir();
  const dbFile = config.dbFile || defaultDbFile();
  let db;
  try {
    db = openDatabase(dbFile);
  } catch (err) {
    ctx.logger?.error?.(`[tide] 打开数据库失败，插件停用: ${err?.message ?? err}`);
    return;
  }
  const vecReady = loadVec(db);
  if (vecReady) {
    try {
      ensureVecTables(db);
    } catch (err) {
      ctx.logger?.warn?.(`[tide] 向量表创建失败: ${err?.message ?? err}`);
    }
  }
  ctx.effect(() => () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }, ROW_ID + '.db');

  const log = (level, kind, detail) => {
    const fn = level === 'error' ? ctx.logger?.error : level === 'warn' ? ctx.logger?.warn : ctx.logger?.info;
    fn?.call?.(ctx.logger, `[tide] ${kind} ${JSON.stringify(detail ?? {})}`);
  };
  log('info', 'init', { dbFile, vec: vecReady });

  // 页面可改的配置覆盖：5 秒缓存，避免每条消息都查库
  let cfgCache = { at: 0, value: cfg };
  const effectiveCfg = () => {
    const revision = settingsRevision(db);
    if (cfgCache.revision === revision && Date.now() - cfgCache.at < 5000) return cfgCache.value;
    try {
      cfgCache = { revision, at: Date.now(), value: applyOverrides(cfg, getOverrides(db)) };
    } catch {
      cfgCache = { revision, at: Date.now(), value: cfg };
    }
    return cfgCache.value;
  };

  // 状态页/接口：单拎出来，作用域 off 时也要挂上，否则用户打不开设置页改作用域。
  const registerStatusPage = (ownerInfo) => {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        try {
          return sctx.webServer.register({
            kind: 'prefix',
            path: ROUTE,
            handler: createPluginHandler(db, { dbFile, cfg, ownerInfo }),
          });
        } catch (err) {
          log('warn', 'plugin-route', { error: String(err?.message ?? err) });
          return () => {};
        }
      }, 'tide.status-page');
    });
  };
  // embedding 惰性加载：失败只降级，不抛。做成可重建的，子进程崩了还能再拉起来。
  const { getEmbedder, resetEmbedder } = createEmbedderManager();
  let embedder = null;
  const embedOptions = {
    model: config.embedding?.model,
    dtype: config.embedding?.dtype,
    cacheDir: config.embedding?.cacheDir || undefined,
    remoteHost: config.embedding?.remoteHost || undefined,
    allowRemote: config.embedding?.allowRemote !== false,
    allowInline: config.embedding?.allowInline === true,
    logFile: join(dirname(dbFile), 'embed.log'),
  };
  let disposed = false;
  let starting = null;
  let nextEmbedAttempt = 0;
  const startEmbedder = () => {
    if (disposed || config.embedding?.enabled === false || starting || Date.now() < nextEmbedAttempt) return;
    starting = getEmbedder(embedOptions)
      .then(async (e) => {
        if (disposed) return;
        if (effectiveCfg().scope.mode === 'off') {
          resetEmbedder();
          return;
        }
        if (!e.ready) nextEmbedAttempt = Date.now() + 60_000;
        embedder = e.ready ? e : null;
        log(e.ready ? 'info' : 'warn', 'embedding', { ready: e.ready, dim: e.dim, error: e.error });
        if (embedder && vecReady) {
          try {
            const rep0 = runJanitor(db, { rawLogDays: cfg.retention?.rawLogDays ?? 0 });
            const bf = await backfillVectors(db, { embedder, putVector, table: 'vec_fact' });
            await backfillAttentionVectors();
            if (rep0.actions.length || bf.attempted) log('info', 'startup-repair', { actions: rep0.actions.length, ...bf });
          } catch (err) {
            log('warn', 'startup-repair', { error: String(err?.message ?? err) });
          }
        }
      })
      .catch((err) => log('warn', 'embedding', { error: String(err?.message ?? err) }))
      .finally(() => { starting = null; });
  };
  // 插件停用/重载/升级时关掉子进程并释放缓存，别让它占着插件目录句柄。
  ctx.effect(() => () => {
    disposed = true;
    try {
      resetEmbedder();
    } catch {
      /* ignore */
    }
    embedder = null;
  }, 'tide.embed');
  if (effectiveCfg().scope.mode !== 'off') void startEmbedder();

  const embedCircuit = createCircuit({ threshold: cfg.routing?.circuitThreshold ?? 5, cooldownMs: cfg.routing?.circuitCooldownMs ?? 60_000 });
  // follow 模式的工作区：优先 dsh-qqbot 配的 cwd，其次宿主默认工作区
  let followCwdCache = { at: 0, value: '' };
  const resolveFollowCwd = () => {
    const now = Date.now();
    if (now - followCwdCache.at < 5000) return followCwdCache.value;
    let value = '';
    try {
      const loader = ctx.get?.('loader');
      for (const entry of loader?.entries?.() ?? []) {
        const name = String(entry?.options?.name ?? '');
        const id = String(entry?.options?.id ?? entry?.id ?? '');
        if (name.includes('qqbot') || id === 'im-qqbot') {
          const cwd = entry?.options?.config?.cwd;
          if (cwd) {
            value = String(cwd);
            break;
          }
        }
      }
    } catch {
      /* loader 不可用就用默认工作区 */
    }
    if (!value) {
      try {
        value = String(ctx.get?.('workingDirectory')?.defaultDirectory ?? '');
      } catch {
        value = '';
      }
    }
    followCwdCache = { at: now, value };
    return value;
  };

  const effectiveScope = () => {
    const sc = effectiveCfg().scope ?? {};
    // 旧配置里的 allowlist 已移除，按 follow 处理
    const rawMode = sc.mode ?? 'off';
    const mode = rawMode === 'allowlist' ? 'follow' : rawMode;
    const ids = String(sc.sessionIds ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    return {
      mode,
      peers: sc.peers ?? [],
      presets: sc.presets ?? [],
      cwd: sc.cwd ?? '',
      sessionIds: ids,
      includeSubagents: sc.includeSubagents === true,
      followCwd: mode === 'follow' ? resolveFollowCwd() : '',
    };
  };

  // 主人身份：从已有 owner.* 事实与 QQ 私聊绑定推断，5 秒缓存
  let ownerCache = { at: 0, ids: new Set() };
  let ownerWarned = false;
  let ownerReasonState = 'unknown';
  /** 读 qqbot 的实时配置；没有这个插件、或读不到 configEditor，都返回 null。 */
  let configEditor = null;
  try {
    ctx.inject(['configEditor'], (sctx) => {
      sctx.effect(() => {
        configEditor = sctx.configEditor;
        return () => {
          configEditor = null;
        };
      }, 'tide.config-editor');
    });
  } catch {
    /* 没有这个服务就只认显式配置 */
  }

  const qqbotAccess = () => {
    try {
      // 服务是可选依赖：inject 没接上时再按文档的 ctx.get 取一次
      const editor = configEditor ?? ctx.get?.('configEditor') ?? null;
      if (!editor) return null;
      const list = typeof editor?.configuration === 'function' ? editor.configuration() : null;
      if (!Array.isArray(list)) return null;
      const nameOf = (it) => String(it?.entry?.name || it?.entry?.id || '');
      const row = list.find((it) => /(dsh-qqbot|im-qqbot)/i.test(nameOf(it)));
      if (!row) return null;
      // 行配置可能在 entry.config 里，也可能是层叠的 inherited/override；三者合并
      const merged = { ...(row.entry?.config ?? {}), ...(row.inherited ?? {}), ...(row.override ?? {}) };
      // qqbot 把访问策略放在 access 下面；旧版本可能平铺，两种都认
      const access = merged.access && typeof merged.access === 'object' ? merged.access : merged;
      return { c2cMode: access.c2cMode, c2cAllow: access.c2cAllow };
    } catch {
      return null;
    }
  };

  const ownerReason = () => ownerReasonState;
  const ownerIds = () => {
    const now = Date.now();
    const revision = settingsRevision(db);
    if (ownerCache.revision === revision && now - ownerCache.at < 5000) return ownerCache.ids;
    // 顺序：显式配置优先；没有就看 qqbot 的名单（语义单独判断）；都没有就是空。
    const { ids, reason } = ownerIdsFromQqbot({
      configured: effectiveCfg().owner?.ids ?? '',
      qqbot: qqbotAccess(),
    });
    ownerReasonState = reason;
    if (!ids.size && !ownerWarned) {
      ownerWarned = true;
      log('warn', 'owner-unset', {
        reason,
        hint: '没有主人：在设置页 owner.ids 里填 openid，或让 qqbot 的私聊名单在 open 模式下提供',
      });
    }
    ownerCache = { at: now, revision, ids };
    return ids;
  };

  const bindingFor = (sessionId) => {
    let cwd;
    let agentPreset;
    let origin;
    try {
      const header = ctx.get?.('sessions')?.get?.(sessionId)?.header;
      cwd = header?.cwd;
      agentPreset = header?.agentPreset;
      origin = header?.origin;
    } catch {
      /* 读不到就当未绑定 */
    }
    const binding = resolveSession({ id: sessionId, cwd, agentPreset, origin }, effectiveScope());
    if (binding && !embedder?.ready) startEmbedder();
    return binding;
  };
  const bindable = (sessionId) => bindingFor(sessionId) !== null;
  const egress = createEgress({ isBindable: bindable, cfg: cfg.egress, log });

  /** 写入向量（失败只记日志，标记 embedding_pending 交给巡检补算）。 */
  const embedAndStore = async (table, rowid, text) => {
    if (!vecReady || !rowid) return false;
    if (!embedder) return false;
    try {
      const [vec] = await embedder.embed([text]);
      putVector(db, table, rowid, vec);
      return true;
    } catch (err) {
      log('warn', 'embed-write', { table, error: String(err?.message ?? err) });
      return false;
    }
  };

  const recordRoute = (sessionId, binding, label, reason) => {
    const turn = 0;
    const correlationId = `${sessionId}:${turn}`;
    appendEvent(db, {
      eventId: `evt-route-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      eventType: 'route_decision',
      content: JSON.stringify({ label, reason }),
      conversationKey: binding.conversationKey,
      occurredAt: Date.now(),
      correlationId,
      status: 'active',
    });
    log('info', 'route', { label, reason });
  };

  /**
   * 用宿主 llm 服务跑一次非流式补全（只为抽取用，失败返回空串）。
   * 走哪个模型由 sel 决定 —— 也就是这个会话当前正在用的模型，插件不自己挑。
   */
  const makeComplete = (ctxRef, sel) => async (messages) => {
    const llm = ctxRef.get?.('llm');
    if (!llm) return '';
    if (!sel?.provider || !sel?.model) return '';
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const chat = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: 'user', content: [{ type: 'text', text: m.content }] }));
    let out = '';
    try {
      for await (const chunk of llm.stream({
        provider: sel.provider,
        model: sel.model,
        ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
        system,
        messages: chat,
        purpose: 'memory-extract',
      })) {
        if (chunk.type === 'text-delta') out += chunk.text;
      }
    } catch (err) {
      log('warn', 'extract-llm', { error: String(err?.message ?? err) });
      return '';
    }
    return out;
  };

  // ── 入站镜像 + generation 观察 ──
  const currentTurns = new Map();
  const lastImageBySession = new Map();
  const imgCallMap = new Map();
  // 会话当前用的模型：抽取跟着它走，插件不自己配 provider/model
  const modelBySession = new Map();
  const repairedSessions = new Set();
  if (cfg.features.writePipeline) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const sessionId = String(payload?.agent?.id ?? '');
      if (!sessionId || !bindable(sessionId)) return next();
      const sel = payload?.modelSelection;
      if (sessionId && sel?.provider && sel?.model) modelBySession.set(sessionId, sel);
      // 每个会话首次拿到模型时补一次历史漏抽
      if (sel?.provider && sel?.model && effectiveCfg().extract.enabled !== false && !repairedSessions.has(sessionId)) {
        repairedSessions.add(sessionId);
        void (async () => {
          try {
            const fix = await runRepairExtractions(db, {
              complete: makeComplete(ctx, sel), ownerIds: ownerIds(), limit: 10, log,
              getExtractSettings: () => disposed || !bindable(sessionId) ? { enabled: false } : effectiveCfg().extract,
            });
            if (fix.attempted || fix.facts || fix.events) log('info', 'extract-repair', fix);
          } catch (err) {
            log('warn', 'extract-repair', { error: String(err?.message ?? err) });
          }
        })();
      }
      return next();
    });
  }
  if (cfg.features.ingest) {
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id;
      if (!sessionId) return;
      const binding = bindingFor(sessionId);
      if (!binding) return;
      if (event.type === 'turn/start') currentTurns.set(sessionId, event.data?.turn ?? 0);

      if (event.type === 'user/message') {
        const rawText = (event.data?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (!rawText) return;
        const norm = inboundBody(rawText);
        if (!norm.usable) return;
        const text = norm.body;
        const who = norm.sender
          ? { userId: norm.sender.id, senderId: norm.sender.id, senderName: norm.sender.name, attribution: 'sender' }
          : parseSender(text, binding);
        if (who.userId) upsertPerson(db, { openid: who.userId, nickname: who.senderName ?? null });
        appendRawLog(db, {
          recordId: `raw-${sessionId}-${event.seq}`,
          recordType: 'message',
          adapter: binding.adapter,
          peerId: binding.peerId,
          userId: who.userId,
          conversationKey: binding.conversationKey,
          platform: 'qq',
          correlationId: `${sessionId}:${currentTurns.get(sessionId) ?? 0}`,
          observedAt: event.time ?? Date.now(),
          payload: text,
          metadata: { seq: event.seq, turn: event.data?.turn, attribution: who.attribution, senderName: who.senderName ?? null },
        });
      }
      // 模型调用记忆类工具的审计（用于 Tool Rescue Rate）
      if (event.type === 'tool/call' && String(event.data?.name ?? '').startsWith('memory_')) {
        try {
          appendEvent(db, {
            eventId: `evt-tool-${sessionId}-${event.seq}`,
            eventType: 'memory_tool_call',
            content: JSON.stringify({ name: event.data.name, callId: event.data.callId }),
            conversationKey: binding.conversationKey,
            occurredAt: event.time ?? Date.now(),
          });
        } catch {
          /* 审计失败不影响主流程 */
        }
      }
      // 图片缓存：记住本轮图片；看图工具的调用与结果配对
      try {
        if (event.type === 'user/message') {
          const text = (event.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
          const img = extractImagePath(text);
          if (img) lastImageBySession.set(sessionId, img);
        } else if (event.type === 'tool/call' && String(event.data?.name ?? '').includes('describe_image')) {
          const rawArgs = String(event.data?.arguments ?? '');
          const direct = extractImagePath(rawArgs);
          const img = direct ?? lastImageBySession.get(sessionId) ?? null;
          if (img && event.data?.callId) imgCallMap.set(String(event.data.callId), img);
        } else if (event.type === 'tool/result') {
          const callId = String(event.data?.toolCallId ?? '');
          const img = callId ? imgCallMap.get(callId) : null;
          if (img && !event.data?.isError) {
            const out = (event.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
            const sha1 = sha1OfFile(img);
            if (sha1 && out.trim()) putCachedImage(db, { sha1, path: img, semantic: out.trim() });
            if (callId) imgCallMap.delete(callId);
          }
        }
      } catch {
        /* 缓存失败不影响主流程 */
      }
      egress.observe(sessionId, event);
      if (event.type === 'turn/end') currentTurns.delete(sessionId);

      // 明确关闭记事的轮次也标记为已处理，避免以后补抽时又写回来。
      if (event.type !== 'turn/end' || !cfg.features.writePipeline || cfg.write?.extractOnTurnEnd === false) return;
      const turn = event.data?.turn ?? 0;
      const correlationId = `${sessionId}:${turn}`;
      const markDisabled = () => {
        const recorded = db.prepare("SELECT 1 FROM event WHERE event_type='memory_extract' AND correlation_id=?").get(correlationId);
        if (!recorded) appendEvent(db, {
          eventId: `evt-extract-disabled-${correlationId}`, eventType: 'memory_extract',
          conversationKey: binding.conversationKey, correlationId, content: JSON.stringify({ skipped: 'disabled' }),
          occurredAt: Date.now(),
        });
      };
      if (effectiveCfg().extract.enabled === false) {
        markDisabled();
        return;
      }
      const sessionModel = modelBySession.get(sessionId);
      if (sessionModel?.provider && sessionModel?.model) {
        // 窗口按时间取，不按轮次：群里一句一句隔几十秒发，一轮常常只有一句话，
        // 代词（我/他/你）就没有前文可解。这里把本轮之前几分钟的对话一并带进去，
        // 但只用来理解指代，抽取仍然只针对本轮那几条。
        const lookbackMinutes = Math.max(0, Number(cfg.extract.lookbackMinutes ?? 5));
        const lookbackMs = lookbackMinutes * 60_000;
        // 本轮消息按 correlation_id 单独取，不受时间窗口影响：
        // lookbackMinutes=0 的语义是「不要前文」，不该连着本轮一起关掉；
        // 一轮聊久了超过窗口也是同一回事。
        const mine = db
          .prepare(
            `SELECT record_id AS recordId, payload, user_id AS userId, metadata, correlation_id AS corr
               FROM raw_log
              WHERE conversation_key = ? AND correlation_id = ? AND record_type = 'message'
              ORDER BY observed_at DESC
              LIMIT ?`,
          )
          .all(binding.conversationKey, correlationId, Number(cfg.extract.lookbackRows ?? 12));
        // 前文才受时间与条数限制
        const earlier =
          lookbackMs > 0
            ? db
                .prepare(
                  `SELECT record_id AS recordId, payload, user_id AS userId, metadata, correlation_id AS corr
                     FROM raw_log
                    WHERE conversation_key = ? AND correlation_id <> ? AND record_type = 'message'
                      AND observed_at > ?
                    ORDER BY observed_at DESC
                    LIMIT ?`,
                )
                .all(binding.conversationKey, correlationId, Date.now() - lookbackMs, Number(cfg.extract.lookbackRows ?? 12))
                .filter((r) => r.payload && !isInjectedBlock(r.payload))
            : [];
        // 只抽本轮的消息。旧写法在空轮会退回整个时间窗口，把早抽过的消息再抽一遍，
        // 造成重复事实和重复经历。
        // 自动记事的总开关：关掉后正常抽取也停，原始聊天记录不受影响
        const rowsForExtract = mine.filter((r) => r.payload && !isInjectedBlock(r.payload));
        if (rowsForExtract.length > 0) {
          // 一轮里可能有多个人说话：按消息各自绑定发言人，别整段归给最后一个人
          // 昵称会重名，所以统一走 labelSpeakers 生成唯一标签，行首和 speaker 字段同一套
          const labeled = (list) =>
            labelSpeakers(
              list.map((r) => ({
                name: safeJson(r.metadata)?.senderName ?? nicknameOf(db, r.userId) ?? null,
                userId: r.userId ?? binding.peerId,
                recordId: r.recordId,
                isOwner: r.userId ? ownerIds().has(r.userId) : binding.scope === 'c2c',
              })),
            );
          const speakers = labeled(rowsForExtract);
          const earlierSpeakers = labeled(earlier);
          const allLabels = [...speakers, ...earlierSpeakers].filter((sp) => sp.name);
          const distinctPeople = new Set(allLabels.map((sp) => String(sp.userId ?? sp.name)));
          const multiSpeaker = distinctPeople.size > 1;
          const renderRows = (list, labels) => {
            // 按记录 id 关联标签：按下标取会在有记录缺昵称时整体错位，
            // 把 A 的话贴成 B 的标签，连证据也跟着记错人。
            const byId = new Map(labels.map((sp) => [String(sp.recordId ?? ''), sp.label]).filter(([id]) => id !== ''));
            return list
              .map((r, i) => {
                const label = byId.get(String(r.recordId ?? '')) ?? labels[i]?.label ?? null;
                return multiSpeaker && label ? `[${label}] ${r.payload}` : r.payload;
              })
              .reverse()
              .join('\n');
          };
          const currentText = renderRows(rowsForExtract, speakers);
          const priorRaw = earlier.length ? renderRows(earlier, earlierSpeakers) : '';
          // 前文只是用来解指代，永远不能把当前消息挤没：先保住当前消息，剩下的空间给前文，
          // 前文从头部裁（它的行是按时间正序的，裁头留下的是离当前最近的那段）。
          const maxChars = Number(cfg.extract.maxChars ?? 3000);
          let priorText = priorRaw;
          const HEAD = '【前文】\n';
          const MID = '\n【当前消息】\n';
          if (priorText) {
            const room = maxChars - currentText.length - HEAD.length - MID.length;
            if (room <= 0) priorText = '';
            else if (priorText.length > room) priorText = priorText.slice(priorText.length - room);
          }
          const text = (priorText ? `${HEAD}${priorText}${MID}${currentText}` : currentText).slice(0, maxChars);
          if (!looksMemorable(currentText, { minChars: cfg.extract.minChars ?? 6 })) return;
          const meta = safeJson(rowsForExtract[0].metadata);
          const latest = rowsForExtract[0];
          void (async () => {
            // 抽取失败重试：次数来自 write.maxAttempts（1–5）
            const attempts = Math.max(1, Math.min(5, Number(cfg.write?.maxAttempts ?? 3)));
            let items = null;
            let lastErr = null;
            for (let attempt = 0; attempt < attempts && !items; attempt += 1) {
              try {
                items = await extractItems({
                  complete: makeComplete(ctx, sessionModel),
                  text,
                  userId: latest.userId ?? binding.peerId,
                  subjectId: latest.userId ?? binding.peerId,
                  assertedBy: latest.userId ?? null,
                  sourceRecordId: latest.recordId,
                  scope: binding.scope === 'group' ? 'group' : binding.scope === 'c2c' ? 'private' : 'local',
                  speakerName: latest.metadata?.senderName ?? nicknameOf(db, latest.userId) ?? null,
                  isOwner: latest.userId ? ownerIds().has(latest.userId) : binding.scope === 'c2c',
                  speakers: multiSpeaker ? speakers : null,
                  hasPriorContext: priorText.length > 0,
                });
              } catch (err) {
                lastErr = err;
              }
            }
            if (!items) {
              log('warn', 'extract-failed', { attempts, error: String(lastErr?.message ?? lastErr) });
              return;
            }

            if (disposed || !bindable(sessionId)) return;
            const writeSettings = effectiveCfg().extract;
            if (writeSettings.enabled === false) {
              markDisabled();
              return;
            }
            let writtenEvents = 0;
            // L3：一次性经历（同一天多件事各存一条，不合并、不当矛盾）
            for (const [i, ev] of (writeSettings.storeEvents === false ? [] : items.events).entries()) {
              const eventId = `evt-obs-${sessionId}-${turn}-${i}-${Date.now()}`;
              try {
                appendEvent(db, {
                  eventId,
                  eventType: 'observation',
                  content: ev.content,
                  userId: ev.userId ?? latest.userId ?? binding.peerId,
                  speakerName: ev.speakerName ?? latest.metadata?.senderName ?? nicknameOf(db, latest.userId),
                  // 私聊统一记成 private，别和群聊混；否则按作用域过滤时 'c2c' 两边都不认
                  scope: binding.scope === 'group' ? 'group' : binding.scope === 'c2c' ? 'private' : 'local',
                  conversationKey: binding.conversationKey,
                  occurredAt: ev.occurredAt ?? Date.now(),
                  correlationId,
                  sourceRecordId: ev.sourceRecordId ?? latest.recordId,
                });
                writtenEvents++;
                const row = db.prepare('SELECT rowid FROM event WHERE event_id = ?').get(eventId);
                if (row) void embedAndStore('vec_event', row.rowid, ev.content);
              } catch (err) {
                log('warn', 'event-write', { error: String(err?.message ?? err) });
              }
            }

            // L2：稳定事实
            const wrote = [];
            const factIdByKey = new Map();
            for (const cand of (writeSettings.storeFacts === false ? [] : items.facts)) {
              try {
                cand.canonicalKey = canonicalKeyOf(db, cand.canonicalKey);
                const out = writeFact(db, cand);
                wrote.push({ key: cand.canonicalKey, outcome: out.outcome, tier: cand.provenanceTier });
                if (out.factId) factIdByKey.set(cand.canonicalKey, out.factId);
                if (out.outcome === 'replaced' && String(out.previousValue ?? '') !== String(cand.value ?? '')) {
                  try {
                    appendEvent(db, {
                      eventId: 'evt-correct-' + out.factId + '-' + out.version,
                      eventType: 'fact_correction',
                      content: JSON.stringify({ key: cand.canonicalKey, from: out.previousValue, to: cand.value }),
                      conversationKey: binding.conversationKey,
                      occurredAt: Date.now(),
                      correlationId,
                    });
                  } catch {
                    /* 审计失败不影响写入 */
                  }
                }
                if (out.versionRowid) {
                  if (cand.subtype === 'rule') {
                    // 规则不进向量：不参与语义唤醒，只常驻注入
                  } else if (embedder && vecReady) {
                    void embedAndStore('vec_fact', out.versionRowid, cand.surface ?? cand.evidence ?? cand.value);
                  } else {
                    try {
                      db.prepare('UPDATE fact_version SET embedding_pending = 1 WHERE fact_id=? AND version=?').run(out.factId, out.version);
                    } catch {
                      /* ignore */
                    }
                  }
                }
                log('info', 'write', { key: cand.canonicalKey, outcome: out.outcome, tier: cand.provenanceTier });
              } catch (err) {
                log('warn', 'write-failed', { key: cand.canonicalKey, error: String(err?.message ?? err) });
              }
            }

            // 关注点：只把模型判断“值得以后搭话”的主题记下来；其余只记录不唤醒
            const attWrote = [];
            if (cfg.attention?.enabled !== false && writeSettings.storeAttention !== false) {
              for (const a of items.attention ?? []) {
                try {
                  const refId = factIdByKey.get(a.refKey) ?? null;
                  const id = addAttention(db, {
                    kind: refId ? 'fact' : 'topic',
                    refId,
                    label: a.label,
                    note: a.note,
                    weight: a.weight ?? 0.5,
                    ttlDays: cfg.attention?.ttlDays ?? 30,
                    blockPatterns: cfg.attention?.blockPatterns ?? [],
                  });
                  if (id) {
                    attWrote.push(a.label);
                    // 关注点进向量空间：之后同类话题直接命中
                    try {
                      const rowid = attentionRowid(db, id);
                      if (rowid && embedder && vecReady) {
                        void embedAndStore('vec_attention', rowid, attentionVectorText({ label: a.label, note: a.note }));
                      }
                    } catch {
                      /* 向量失败不影响关注点本身 */
                    }
                  }
                } catch (err) {
                  log('warn', 'attention-write', { error: String(err?.message ?? err) });
                }
              }
            }

            try {
              appendEvent(db, {
                eventId: `evt-extract-${sessionId}-${turn}-${Date.now()}`,
                eventType: 'memory_extract',
                content: JSON.stringify({ chars: text.length, facts: wrote.length, events: writtenEvents, attention: attWrote.length, wrote }),
                conversationKey: binding.conversationKey,
                occurredAt: Date.now(),
                correlationId,
              });
            } catch {
              /* 审计失败不影响主流程 */
            }
            void meta;
          })();
        }
      }
    });
  }

  // ── 拒答工具：无论从哪条链路调进来（直接调、还是包在 run_code 里），都立刻把本轮标记为静默 ──
  // 有些 preset 只把 run_code 暴露给模型，工具在里面以 tools.xxx 调用，流的顶层看不到工具名，
  // 所以必须在这一层认，而不是只在 llm/stream 里看名字。
  ctx.on('tools/execute', async (exec, next) => {
    try {
      if (exec?.name === 'stay_silent' && exec?.agent?.id && bindable(String(exec.agent.id))) {
        egress.declareSilent(String(exec.agent.id));
      }
    } catch {
      /* 标记失败不影响调用本身 */
    }
    return next();
  });

  // ── 系统提示：规矩常驻 + 可选人设 ──
  // 规矩放这里而不是塞用户消息：约束力更强、不会被压缩当对话摘要、也不用定期重发。
  // 只对归我们管的会话生效——作用域判定和注入共用同一个 bindingFor。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const downstream = await next();
    try {
      const sessionId = String(context?.agent?.session?.id ?? context?.agent?.id ?? '');
      if (!sessionId) return downstream;
      const binding = bindingFor(sessionId);
      if (!binding) return downstream;
      const cctx = effectiveCfg().context;
      const pcfg = effectiveCfg().persona ?? {};
      const additions = [];
      const rules = renderRuleSection(db, binding, { maxChars: cctx.ruleMaxChars ?? 5000 });
      if (rules.text) additions.push({ name: 'tide:rules', text: rules.text, interpolate: false });
      if (rules.dropped > 0) log('warn', 'rule-truncated', { dropped: rules.dropped, maxChars: cctx.ruleMaxChars ?? 5000 });
      if (pcfg.mode === 'custom') {
        const persona = renderPersonaSection(pcfg.text);
        if (persona) additions.push({ name: 'tide:persona', text: persona, interpolate: false });
      }
      if (!additions.length) return downstream;
      const sections = (downstream?.sections ?? []).filter((sec) => !String(sec?.name ?? '').startsWith('tide:'));
      return { ...downstream, sections: [...sections, ...additions] };
    } catch (err) {
      log('warn', 'prompt-assemble', { error: String(err?.message ?? err) });
      return downstream;
    }
  });

  // ── 群聊里的工具报错：只换给模型看的文本，工具失败这件事不变 ──
  // 拦截点选在 tools/post-execute：模型还没读到结果，原始报错进不了上下文，
  // 也就不会原样转到群里。私聊、本地会话、子代理一律不动。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    try {
      const sessionId = exec?.agent?.id;
      const binding = sessionId ? bindingFor(sessionId) : null;
      const out = hideToolErrorDecision({
        decision,
        result,
        toolName: exec?.name,
        binding,
        enabled: effectiveCfg().egress?.hideToolErrors !== false,
      });
      if (out !== decision) log('info', 'tool-error-hidden', { tool: String(exec?.name ?? ''), conversation: binding?.conversationKey });
      return out;
    } catch (err) {
      log('warn', 'tool-error-hidden', { error: String(err?.message ?? err) });
      return decision;
    }
  });

  // ── 出站闸门：文本挂起 + 括号旁白拦截 ──
  // 闸门本身可关，但「整条只是括号旁白」这类噪音与闸门无关，始终拦。
  ctx.on('llm/stream', (options, next) => {
    if (options?.purpose === 'compaction') {
      const messages = options.messages ?? [];
      const keep = messages.filter((m) => !isTaggedMemory(m));
      return keep.length === messages.length ? next() : ctx.get('llm').stream({ ...options, messages: keep });
    }
    const iter = next();
    const sessionId = options?.sessionId;
    if (!sessionId || effectiveCfg().features.egressGate === false) return iter;
    // 静默时必须能把正文挡住，所以默认包装；只有用户显式关掉 holdTextOnSilence 才直通。
    return egress.wrapStream(String(sessionId), iter, { gate: effectiveCfg().egress?.holdTextOnSilence !== false });
  }, { prepend: true });

  // ── 路由：一级标签 + 策略/禁言 + 环境消息判定；reject 即零模型调用 ──
  { // 始终注册：开关在运行时读，关闭时才放行
    ctx.on('agent/pre-step', async (payload, next) => {
      // 设置页可以随时关掉「群里按需接话」；关掉就等于放行，不再零模型调用地拦截。
      if (effectiveCfg().features?.routing === false) return next();
      const sessionId = String(payload?.agent?.id ?? '');
      const binding = bindingFor(sessionId);
      if (!binding) return next();
      // 只有群聊需要「要不要接」的判定；私聊、本地会话一律放行
      if (binding.scope !== 'group') return next(); // non-group-skip
      const isGroup = true;
      try {
        // 到期策略先自取消（规则层判断）
        for (const pol of reapExpiredPolicies(db)) {
          appendEvent(db, {
            eventId: 'evt-' + pol.policyId + '-expired',
            eventType: 'route_policy_expired',
            content: null,
            conversationKey: pol.conversationKey,
            occurredAt: Date.now(),
          });
        }
        const claimed = payload?.messages ?? [];
        // 宿主会往这一批里塞 system-reminder、插件上下文、时间行；只取最后一条真人消息
        // 引用回复/聊天历史都包在同一条文本里，先剥信封再判元信息
        const human = [];
        for (const m of claimed) {
          const raw = (m?.content ?? []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
          if (!raw) continue;
          const norm = inboundBody(raw);
          if (!norm.usable) continue;
          if (isInjectedBlock(norm.body)) continue;
          if (norm.body.startsWith('[Plugin context')) continue;
          human.push({ raw, body: norm.body });
        }
        const lastHuman = human.length ? human[human.length - 1] : null;
        const text = lastHuman ? lastHuman.body : '';
        if (!text) return next();
        // clearBody 会把 (@you) 抹掉，所以从原始文本判断有没有被点名
        const isMentioned = String(lastHuman.raw).includes('(@you)');
        // 入站镜像兜底：被 reject 的消息不会产生 user/message 事件，这里先落 raw_log
        for (const m of claimed) {
          const raw = (m?.content ?? []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
          if (!raw) continue;
          const norm = inboundBody(raw);
          if (!norm.usable) continue;
          const who = norm.sender
            ? { userId: norm.sender.id, senderName: norm.sender.name, attribution: 'sender' }
            : parseSender(norm.body, binding);
          try {
            if (who.userId) upsertPerson(db, { openid: who.userId, nickname: who.senderName ?? null });
            appendRawLog(db, {
              recordId: 'raw-pre-' + sessionId + '-' + (m?.id ?? Date.now()),
              recordType: 'message',
              adapter: binding.adapter,
              peerId: binding.peerId,
              userId: who.userId,
              conversationKey: binding.conversationKey,
              platform: 'qq',
              correlationId: sessionId + ':' + (currentTurns.get(sessionId) ?? 0),
              observedAt: Date.now(),
              payload: norm.body,
              metadata: { stage: 'pre-step', attribution: who.attribution, senderName: who.senderName ?? null },
            });
          } catch {
            /* 镜像失败不影响路由 */
          }
        }
        // 纯图片消息看不出语义：没被点名就不该参与判定，更不该接茬
        if (isImageOnly(text) && !isMentioned) {
          recordRoute(sessionId, binding, 'irrelevant_ambient', 'image-only');
          return { kind: 'reject' };
        }
        const decision = await decideRoute({
          db,
          cfg: effectiveCfg(),
          binding,
          text,
          isMentioned,
          embedder,
          vecReady,
          circuitOpen: vecReady && embedCircuit.isOpen('embed'),
          complete: makeComplete(ctx, modelBySession.get(sessionId)),
          random: Math.random,
        });
        if (decision.detail.embedError) embedCircuit.recordFailure('embed');
        else if (decision.detail.embedSucceeded) embedCircuit.recordSuccess('embed');
        recordRoute(sessionId, binding, decision.label, decision.reason);
        // 探索唤醒的话题先记账；反复出现才会升成关注点
        const extract = effectiveCfg().extract;
        if (decision.reason === 'ambient-explore' && extract.enabled !== false && extract.storeAttention !== false) {
          try {
            recordTopicCandidate(db, text);
          } catch {
            /* 记账失败不影响本轮 */
          }
        }
        if (decision.action === 'reject') return { kind: 'reject' };
        return next();
      } catch (err) {
        log('warn', 'route', { error: String(err?.message ?? err) });
        return next();
      }
    });
  }

  /** 注入诊断日志。写不进也不影响注入。 */
  const writeInjectLog = (extra) => {
    try {
      if (effectiveCfg().diagnostics?.injectLog === false) return;
      const logPath = join(dirname(dbFile), 'inject.log');
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...extra }) + '\n');
    } catch {
      /* 诊断失败不影响注入 */
    }
  };

  // ── 上下文注入：记忆块进对话，但「退役旧块」只在 step 开着的时候做 ──
  // 宿主的日志校验要求 system/message 落在一个开着的 turn+step 里。在 pre-step 里写
  // （step 还没开）或 turn/end 之后写，会让整个会话被判「损坏」，下次加载直接失败。
  // 所以 pre-step 只决定这一轮放什么，真正的清理推迟到 step/start 之后的一个微任务里。
  { // 始终注册：开关在运行时读
    /** session -> { turn, step, text, messages }；text 为 null 表示这一轮什么都不动。 */
    const desired = new WeakMap();
    ctx.on('agent/pre-step', async (payload, next) => {
      const { agent, turn, step } = payload;
      const session = agent?.session;
      const binding = bindingFor(String(agent?.id ?? ''));
      if (!binding) {
        // 离开作用域后只清理来源明确的 Tide 块，用户贴出的同名文本保留。
        const decision = await next();
        if (!session || decision?.kind !== 'enter') return decision;
        desired.set(session, { turn, step, text: '', taggedOnly: true });
        const messages = decision.messages ?? [];
        return messages.some(isTaggedMemory) ? { ...decision, messages: messages.filter((m) => !isTaggedMemory(m)) } : decision;
      }
      const injectOn = effectiveCfg().features?.contextInject !== false;
      if (!injectOn) {
        // 关掉的时候只做两件事：这一步不注入、并从本轮消息里剔除旧块。
        // 真正的「退役旧块」要等 step/start（那时 step 才开着），在 pre-step 写会判会话损坏。
        const offDecision = await next();
        const offMessages = offDecision?.messages ?? [];
        if (offDecision?.kind === 'enter' && session?.surface?.nodes && typeof session?.eventAt === 'function') {
          let s2 = desired.get(session);
          if (!s2) {
            s2 = { turn, step, text: '', messages: [] };
            desired.set(session, s2);
          }
          s2.turn = turn;
          s2.step = step;
          s2.text = '';
        } else {
          desired.delete(session);
        }
        return offMessages.some(isMemoryBlock)
          ? { ...offDecision, messages: offMessages.filter((m) => !isMemoryBlock(m)) }
          : offDecision;
      }
      if (!session?.surface?.nodes || typeof session?.eventAt !== 'function') return next();
      let state = desired.get(session);
      if (!state || state.taggedOnly) {
        state = { turn, step, text: null, messages: [] };
        desired.set(session, state);
      }
      state.turn = turn;
      state.step = step;
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') {
          state.text = null;
          return decision;
        }
        const cctx = effectiveCfg().context;
        const existing = memoryNodes(session);
        const messages = decision.messages ?? [];
        // 同轮的工具后续步骤可能没有新消息，继续以触发这轮的消息召回。
        if (payload.messages?.length) state.messages = payload.messages;
        const { factBlock, eventBlock, eventIdsIncluded } = buildInjection({ db, binding, payload: state, cfg: cctx });
        // 图片缓存命中：同一张图别再让模型看一遍
        let imageHint = '';
        try {
          const imgSrc = state.messages
            .map((m) => (m?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'))
            .join('\n');
          const imgPath = extractImagePath(imgSrc);
          if (imgPath) {
            const sha1 = sha1OfFile(imgPath);
            const cached = getCachedImage(db, sha1);
            if (cached) imageHint = renderImageHint(cached);
          }
        } catch {
          /* 缓存失败不影响注入 */
        }
        const block = [factBlock, eventBlock, imageHint].filter(Boolean).join('\n\n');
        state.text = block;
        // 内容相同的块只要已经有一份就算复用；多出来的副本由 step/start 那步清掉。
        // 只在「恰好一份」时才复用，会让重复块每轮再加一份，越攒越多。
        const reuse = existing.some((node) => memoryText(node) === block);
        const msg = !reuse && block ? createUserMessage({ source: { kind: TIDE_MEMORY_SOURCE }, content: textOut(block) }) : null;
        const kept = (cctx.stripReasoning === false ? messages : stripReasoning(messages)).filter((m) => !isMemoryBlock(m));
        writeInjectLog({
          conversation: binding.conversationKey,
          scope: binding.scope,
          blocksBefore: existing.length,
          blocksAfter: reuse ? existing.length : msg ? 1 : 0,
          action: msg ? 'inject' : existing.length && !reuse ? 'clear' : 'skip',
          factChars: factBlock.length,
          eventChars: eventBlock.length,
          factSent: msg ? factBlock.length : 0,
          eventsSent: msg ? eventIdsIncluded.length : 0,
          eventCharsSent: msg ? eventBlock.length : 0,
        });
        return { ...decision, messages: msg ? [...kept, msg] : kept };
      } catch (err) {
        state.text = null; // 出错就不动旧块，避免误删
        log('warn', 'context-inject', { error: String(err?.message ?? err) });
        return decision;
      }
    }, { prepend: true });

    // step 已经开着：这时替换旧记忆块是合法位置，而且赶在宿主构建请求之前。
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'step/start') return;
      const turn = event.data?.turn;
      const step = event.data?.step;
      const state = desired.get(session);
      if (!state || state.turn !== turn || state.step !== step) return;
      // 宿主发布事件时禁止同步追加，推迟到微任务；此时 step 仍开着。
      queueMicrotask(() => {
        if (desired.get(session) !== state) return;
        if (state.text === null || !session.surface?.nodes || typeof session.eventAt !== 'function') return;
        try {
          // 只退役「和这一轮应当显示的内容不一致」的旧块；内容相同的保留（复用）。
          const nodes = memoryNodes(session).filter((node) => !state.taggedOnly || isTaggedMemory(node.data));
          const strong = String(state.text ?? '');
          // 该显示的这份保留一份；内容不满意的退役；内容相同但重复的副本也退役。
          let keptOne = false;
          const stale = nodes.filter((node) => {
            const text = memoryText(node);
            if (text !== strong) return true;
            if (!keptOne) {
              keptOne = true;
              return false;
            }
            return true;
          });
          if (stale.length) retireMemoryNodes(session, stale, turn, step, createSystemMessage);
        } catch (err) {
          log('warn', 'context-retire', { error: String(err?.message ?? err) });
        }
      });
    });
  }

  // ── 巡检：低频，只报告不静默改 ──
  if (cfg.janitor.enabled) {
    const timer = setInterval(() => {
      if (effectiveCfg().scope.mode === 'off') return;
      try {
        const rep = runJanitor(db, { rawLogDays: cfg.retention?.rawLogDays ?? 0 });
        try { rep.attention = pruneAttention(db, { maxActive: cfg.attention?.maxActive ?? 80, expireDays: cfg.attention?.ttlDays ?? 30 }); } catch { /* ignore */ }
        try {
          if (effectiveCfg().extract.enabled !== false && effectiveCfg().extract.storeAttention !== false) rep.promoted = promoteCandidates(db, {
            minCount: cfg.attention?.promoteAfter ?? 2,
            maxAgeDays: 7,
            max: 3,
            addAttention: (dbi, arg) => addAttention(dbi, { ...arg, blockPatterns: cfg.attention?.blockPatterns ?? [] }),
          });
        } catch { /* ignore */ }
        if (embedder && vecReady) {
          void backfillVectors(db, { embedder, putVector, table: 'vec_fact' }).then((r) => {
            if (r.done || r.failed) log('info', 'backfill', r);
          });
          void backfillAttentionVectors();
        }
        pruneBudgets(db);
        if (rep.actions.length) log('info', 'janitor', { actions: rep.actions.length, staleConflicts: rep.staleConflicts.length });
      } catch (err) {
        log('warn', 'janitor', { error: String(err?.message ?? err) });
      }
    }, cfg.janitor.intervalMinutes * 60_000);
    timer.unref?.();
    ctx.effect(() => () => clearInterval(timer), 'tide.janitor');
  }

  // ── 聊天预设：可选注册，不写进用户的 profile 补丁 ──
  // 用 ctx.inject 等到 agentPresets 就绪再挂；服务重建时跟着重挂。
  if (effectiveCfg().preset?.enabled === true) {
    ctx.inject(['agentPresets'], (sctx) => {
      sctx.effect(() => {
        let dispose = null;
        let disposed = false;
        void registerChatPreset(sctx.agentPresets, { log }).then((d) => {
          dispose = d;
          // 注册还没回来就被禁用：立刻注销，别留下一个孤儿预设
          if (disposed && typeof d === 'function') void d();
        });
        return () => {
          disposed = true;
          if (typeof dispose === 'function') void dispose();
        };
      }, 'tide.chat-preset');
    });
  }

  // ── 只读状态页：/tide（仅本机） ──
  if (effectiveCfg().features?.statusPage !== false) {
    registerStatusPage(() => ({ ids: [...ownerIds()], reason: ownerReason() }));
  }

  // 关注点向量补算（启动一次 + 定时器里做）
  const backfillAttentionVectors = async () => {
    if (!vecReady || !embedder) return 0;
    let n = 0;
    try {
      for (const row of attentionNeedingVector(db, 200)) {
        const ok = await embedAndStore('vec_attention', row.rowid, attentionVectorText(row));
        if (ok) n++;
      }
    } catch (err) {
      log('warn', 'attention-vec-backfill', { error: String(err?.message ?? err) });
    }
    if (n > 0) log('info', 'attention-vec-backfill', { added: n });
    return n;
  };

  // ── 工具面 ──
  const tools = [
    {
      name: 'memory_search',
      description: '检索长期记忆（事实 + 事件）。返回候选与分数。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
        required: ['query'],
      },
      output: output({ type: 'object' }),
      execute(args) {
        const limit = args.limit ?? 10;
        const facts = searchFacts(db, args.query, limit);
        const events = searchEvents(db, args.query, limit);
        return { facts, events };
      },
    },
    {
      name: 'fact_get',
      description: '读取结构化事实的候选集：每条候选返回当前值与状态（active/superseded/deleted），版本裁决由调用方处理。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          entityId: { type: 'string' },
          canonicalKey: { type: 'string' },
          subtype: { type: 'string' },
        },
        required: ['userId', 'entityId', 'canonicalKey'],
      },
      output: output({ type: 'array' }),
      execute(args) {
        return getCandidates(db, args);
      },
    },
    {
      name: 'fact_exists',
      description: '确定性检查某事实是否存在（只看 active）。',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'string' }, entityId: { type: 'string' }, canonicalKey: { type: 'string' }, subtype: { type: 'string' } },
        required: ['userId', 'entityId', 'canonicalKey'],
      },
      output: output({ type: 'object' }),
      execute(args) {
        const rows = getCandidates(db, args).filter((r) => r.status === 'active');
        return { exists: rows.length > 0, candidates: rows };
      },
    },
    {
      name: 'memory_write_candidate',
      description: '提交一条事实候选。低证据等级的候选不会成为 active。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          entityId: { type: 'string' },
          canonicalKey: { type: 'string' },
          subtype: { type: 'string' },
          value: { type: 'string' },
          provenanceTier: { type: 'string', enum: ['human_explicit', 'source_verifiable', 'agent_inferred'] },
          occurredAt: { type: 'integer' },
          assertedBy: { type: 'string' },
          subjectId: { type: 'string' },
        },
        required: ['userId', 'canonicalKey', 'value', 'provenanceTier'],
      },
      output: output({ type: 'object' }),
      execute(args) {
        return writeFact(db, { ...args, observedAt: Date.now() });
      },
    },
    {
      name: 'memory_forget',
      description: '删除事实或事件（软删 + 解除索引）。',
      parameters: {
        type: 'object',
        properties: { factId: { type: 'string' }, eventId: { type: 'string' }, confirm: { type: 'boolean' }, reason: { type: 'string' } },
      },
      output: output({ type: 'object' }),
      execute(args) {
        const reason = String(args.reason ?? 'tool:memory_forget').slice(0, 200);
        if (args.factId) {
          const row = db.prepare('SELECT provenance_tier AS tier, status FROM fact WHERE fact_id=?').get(args.factId);
          if (!row) return { outcome: 'not-found' };
          if (row.tier === 'human_explicit' && args.confirm !== true) {
            return { outcome: 'needs_confirm', tier: row.tier, hint: '这是用户原话，删除请带 confirm:true 并说明 reason' };
          }
          return deleteFact(db, args.factId, { reason });
        }
        if (args.eventId) {
          deleteEvent(db, args.eventId, { reason });
          return { outcome: 'deleted', eventId: args.eventId };
        }
        return { outcome: 'no-target' };
      },
    },
    {
      name: 'memory_get',
      description: '按事件 id 取详情，或按 fact id 取当前值。',
      parameters: { type: 'object', properties: { eventId: { type: 'string' }, factId: { type: 'string' } } },
      output: output({ type: 'object' }),
      execute(args) {
        if (args.factId) return getCurrentFact(db, args.factId) ?? null;
        if (args.eventId) return db.prepare('SELECT * FROM event WHERE event_id = ?').get(args.eventId) ?? null;
        return null;
      },
    },
  ];

  if (cfg.features.writePipeline) {
    tools.push({
      name: 'memory_resolve',
      description: '多跳事实合并：按用户/实体/键批量取候选，用来源层级+时间做确定性仲裁，返回主值与备选。',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                userId: { type: 'string' },
                entityId: { type: 'string' },
                canonicalKey: { type: 'string' },
                subtype: { type: 'string' },
              },
              required: ['userId', 'entityId', 'canonicalKey'],
            },
          },
        },
        required: ['keys'],
      },
      output: output({ type: 'array' }),
      execute(args) {
        return (args.keys ?? []).map((k) => ({
          requested: k,
          ...mergeCandidates(getCandidates(db, k)),
        }));
      },
    });
  }

  {
    tools.push({
      name: 'route_policy_set',
      description: '设置临时路由覆盖（C）：direct_only / no_ambient / mute_peer。最长 30 分钟，到期自动失效。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['direct_only', 'no_ambient', 'mute_peer'] },
          ttlMinutes: { type: 'integer', minimum: 1, maximum: 30 },
        },
        required: ['mode'],
      },
      output: output({ type: 'object' }),
      execute(args, exec) {
        const sessionId = String(exec?.agent?.id ?? '');
        const binding = bindingFor(sessionId);
        if (!binding) return { ok: false, reason: 'out-of-scope' };
        return setRoutePolicy(db, {
          conversationKey: binding.conversationKey,
          mode: args.mode,
          ttlMs: (args.ttlMinutes ?? 30) * 60_000,
          setBy: 'model',
        });
      },
    });
  }

  if (cfg.features.tools !== false) {
    tools.push(
      {
        name: 'stay_silent',
        // 工具契约里把用法写死：不想接话就结束本轮，而不是留一句占位
        description:
          '本轮不出站。不想接话、不该插嘴、打算安静看着时调用它：正文会被丢弃，本轮立即结束，群里一个字都收不到。'
          + '不要用「（图跳过）」「这条不是问我的」这类占位或声明代替它——那些本身就是一条消息。',
        parameters: { type: 'object', properties: { reason: { type: 'string' } } },
        output: output({ type: 'object' }),
        execute(args, exec) {
          const sessionId = exec?.agent?.id;
          if (sessionId) egress.declareSilent(String(sessionId));
          try {
            exec?.concludeTurn?.();
          } catch {
            /* ignore */
          }
          return { silent: true, reason: args?.reason ?? null };
        },
      },
      {
        name: 'reply',
        description: '可选：显式声明本轮回复（用于审计与一轮一条）。',
        parameters: { type: 'object', properties: { note: { type: 'string' } } },
        output: output({ type: 'object' }),
        execute(args, exec) {
          const sessionId = exec?.agent?.id;
          if (sessionId) egress.declareReply(String(sessionId));
          return { reply: true, note: args?.note ?? null };
        },
      },
    );
  }

  // 作用域强校验：when 只是“看得见”，执行前必须再过一次绑定检查
  const guardTool = (def) => async (args, exec) => {
    const id = exec?.agent?.id ? String(exec.agent.id) : '';
    if (!id || !bindingFor(id)) return { ok: false, reason: 'out-of-scope' };
    if (!toolEnabled(def)) return { ok: false, reason: 'routing-disabled' };
    return def.execute(args, exec);
  };
  const toolEnabled = (def) => def.name !== 'route_policy_set' || effectiveCfg().features.routing !== false;

  // 只在受管会话里可见：scope=off 时任何会话都拿不到这些工具（装完即静默）
  const when = (context) => {
    const id = context?.agent?.id;
    return id ? bindable(String(id)) : false;
  };

  // 写入类工具默认不开放：被动抽取已经负责写入，模型直写容易产生重复
  const WRITE_TOOLS = new Set(['memory_write_candidate', 'memory_forget']);
  const allowWriteTools = cfg.features.writeTools === true;
  const visibleTools = (cfg.features.tools === false)
    ? []
    : tools.filter((t) => allowWriteTools || !WRITE_TOOLS.has(t.name));
  for (const def of visibleTools) {
    try {
      ctx.tools.register({
        ...def, execute: guardTool(def), isConcurrencySafe: () => true,
        when: (context) => toolEnabled(def) && when(context),
      });
    } catch (err) {
      log('warn', 'tool-register', { name: def.name, error: String(err?.message ?? err) });
    }
  }

  log('info', 'ready', { tools: tools.length, egress: cfg.features.egressGate });
}
