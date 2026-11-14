// DSH 插件入口：Tide（记忆核心 + 出站闸门）
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Config } from './config.js';
import { openDatabase } from './db.js';
import { loadVec, ensureVecTables, putVector, knn, distanceToCosine } from './vec.js';
import { getEmbedder } from './embed.js';
import { appendEvent, appendRawLog, deleteEvent } from './events.js';
import { deleteFact, getCandidates, getCurrentFact, writeFact } from './facts.js';
import { searchEvents, searchFacts } from './fts.js';
import { createEgress } from './egress.js';
import { parseSender, resolveBinding, resolveSession } from './scope.js';
import { extractItems } from './extract.js';
import { isMetaText, isInjectedBlock, looksMemorable, isImageOnly } from './prefilter.js';
import { normalizeInbound, isSystemNoise } from './qqtext.js';
import { runRepairExtractions } from './repair.js';
import { addAttention, pruneAttention, attentionRowid, attentionVectorText, attentionNeedingVector } from './attention.js';
import { recordTopicCandidate, promoteCandidates } from './topics.js';
import { ROUTE, ROW_ID, defaultDbFile, ensureDataDir } from './const.js';
import { buildInjection, diffInjection } from './inject.js';
import { applyOverrides, getOverrides } from './settings.js';
import { upsertPerson, canonicalKeyOf, nicknameOf } from './people.js';
import { extractImagePath, sha1OfFile, getCachedImage, putCachedImage, renderImageHint } from './images.js';
import { decideRoute } from './route-decision.js';
import { createStatusHandler } from './status-page.js';
import { createPluginHandler } from './api.js';
import { selectFacts, selectFactsForUsers, selectFactsForSpeakers, selectFactsForInjection, selectRuleFacts, renderFactBlock, renderRuleBlock, renderEventBlock, plainContextMessage, isValidUserMessageShape } from './context.js';
import { runJanitor, backfillVectors } from './janitor.js';
import { classify, decideAmbient, actionFor, budgetGate } from './route.js';
import { classifyByLlm } from './llmroute.js';
import { consumeBudget, pruneBudgets } from './budget.js';
import { createCircuit } from './circuit.js';
import { mergeCandidates } from './merge.js';
import { activePolicies, activeSilence, applyPolicies, reapExpiredPolicies, setRoutePolicy } from './silence.js';

export const name = 'tide';
export const inject = ['tools'];
export { Config };

const textOut = (text) => [{ type: 'text', text }];
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** 注入块必须是合法 UserMessage：带 source.kind，否则宿主在派生消息时会读 undefined.kind。 */
const buildContextMessage = (text) => {
  try {
    return createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    });
  } catch (err) {
    log('warn', 'context-message', { error: String(err?.message ?? err) });
    return plainContextMessage(text);
  }
};
const output = (schema) => ({ schema, render: (_args, value) => textOut(JSON.stringify(value, null, 2)) });

export async function apply(ctx, config) {
  const cfg = {
    egress: { holdTextOnSilence: true, ...(config.egress ?? {}) },
    features: { ingest: true, writePipeline: true, egressGate: true, contextInject: false, routing: false, tools: true, ...(config.features ?? {}) },
    extract: { provider: '', model: '', maxChars: 3000, ...(config.extract ?? {}) },
    context: {
      enabled: false,
      maxChars: 1200,
      ruleMaxChars: 1800,
      eventLimit: 5,
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
    if (Date.now() - cfgCache.at < 5000) return cfgCache.value;
    try {
      cfgCache = { at: Date.now(), value: applyOverrides(cfg, getOverrides(db)) };
    } catch {
      cfgCache = { at: Date.now(), value: cfg };
    }
    return cfgCache.value;
  };

  // 作用域 off：不注册工具、不监听事件，装完即静默（能力面为零）
  if ((cfg.scope?.mode ?? 'off') === 'off') {
    log('info', 'idle', { reason: 'scope=off' });
    return;
  }

  // embedding 惰性加载：失败只降级，不抛
  let embedder = null;
  if (config.embedding?.enabled !== false) {
    void getEmbedder({
        model: config.embedding?.model,
        dtype: config.embedding?.dtype,
        cacheDir: config.embedding?.cacheDir || undefined,
        remoteHost: config.embedding?.remoteHost || undefined,
        logFile: join(dirname(dbFile), 'embed.log'),
      })
      .then(async (e) => {
        embedder = e.ready ? e : null;
        log(e.ready ? 'info' : 'warn', 'embedding', { ready: e.ready, dim: e.dim, error: e.error });
        if (cfg.features.writePipeline && cfg.extract.provider && cfg.extract.model) {
          try {
            const fix = await runRepairExtractions(db, { complete: makeComplete(ctx), limit: 10, log });
            if (fix.attempted || fix.facts || fix.events) log('info', 'extract-repair', fix);
          } catch (err) {
            log('warn', 'extract-repair', { error: String(err?.message ?? err) });
          }
        }
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
      .catch((err) => log('warn', 'embedding', { error: String(err?.message ?? err) }));
  }

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
    return resolveSession({ id: sessionId, cwd, agentPreset, origin }, effectiveScope());
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

  /** 用宿主 llm 服务跑一次非流式补全（只为抽取用，失败返回空串）。 */
  const makeComplete = (ctxRef) => async (messages) => {
    const llm = ctxRef.get?.('llm');
    if (!llm) return '';
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
        provider: cfg.extract.provider,
        model: cfg.extract.model,
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
  const lastInjectBlock = new Map();
  if (cfg.features.ingest) {
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id;
      if (!sessionId) return;
      const binding = bindingFor(sessionId);
      if (event.type === 'turn/start') currentTurns.set(sessionId, event.data?.turn ?? 0);
      if (!binding) return;

      if (event.type === 'user/message') {
        const rawText = (event.data?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (!rawText) return;
        if (isMetaText(rawText) || isSystemNoise(rawText)) return;
        const norm = normalizeInbound(rawText);
        const text = norm.current;
        if (!text) return;
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

      // 轮末抽取：只在本轮有用户消息、且配置了抽取模型时跑
      if (
        event.type === 'turn/end' &&
        cfg.features.writePipeline &&
        cfg.write?.extractOnTurnEnd !== false &&
        cfg.extract.provider &&
        cfg.extract.model
      ) {
        const turn = event.data?.turn ?? 0;
        const correlationId = `${sessionId}:${turn}`;
        const rows = db
          .prepare(
            `SELECT record_id AS recordId, payload, user_id AS userId, metadata
               FROM raw_log
              WHERE conversation_key = ? AND correlation_id = ? AND record_type = 'message'
              ORDER BY observed_at DESC
              LIMIT 5`,
          )
          .all(binding.conversationKey, correlationId);
        const rowsForExtract = rows.filter((r) => r.payload && !isInjectedBlock(r.payload));
        if (rowsForExtract.length > 0) {
          const text = rowsForExtract
            .map((r) => r.payload)
            .reverse()
            .join('\n')
            .slice(0, cfg.extract.maxChars);
          if (!looksMemorable(text, { minChars: cfg.extract.minChars ?? 6 })) return;
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
                  complete: makeComplete(ctx),
                  text,
                  userId: latest.userId ?? binding.peerId,
                  subjectId: latest.userId ?? binding.peerId,
                  assertedBy: latest.userId ?? null,
                  sourceRecordId: latest.recordId,
                  scope: binding.scope === 'group' ? 'group' : binding.scope === 'c2c' ? 'private' : 'local',
                });
              } catch (err) {
                lastErr = err;
              }
            }
            if (!items) {
              log('warn', 'extract-failed', { attempts, error: String(lastErr?.message ?? lastErr) });
              return;
            }

            // L3：一次性经历（同一天多件事各存一条，不合并、不当矛盾）
            for (const [i, ev] of (cfg.extract.storeEvents === false ? [] : items.events).entries()) {
              const eventId = `evt-obs-${sessionId}-${turn}-${i}-${Date.now()}`;
              try {
                appendEvent(db, {
                  eventId,
                  eventType: 'observation',
                  content: ev.content,
                  userId: ev.userId ?? latest.userId ?? binding.peerId,
                  speakerName: latest.metadata?.senderName ?? nicknameOf(db, latest.userId),
                  scope: binding.scope,
                  conversationKey: binding.conversationKey,
                  occurredAt: ev.occurredAt ?? Date.now(),
                  correlationId,
                  sourceRecordId: latest.recordId,
                });
                const row = db.prepare('SELECT rowid FROM event WHERE event_id = ?').get(eventId);
                if (row) void embedAndStore('vec_event', row.rowid, ev.content);
              } catch (err) {
                log('warn', 'event-write', { error: String(err?.message ?? err) });
              }
            }

            // L2：稳定事实
            const wrote = [];
            const factIdByKey = new Map();
            for (const cand of (cfg.extract.storeFacts === false ? [] : items.facts)) {
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
            if (cfg.attention?.enabled !== false && cfg.extract.storeAttention !== false) {
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
                content: JSON.stringify({ chars: text.length, facts: items.facts.length, events: items.events.length, attention: attWrote.length, wrote }),
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

  // ── 出站闸门：文本挂起 ──
  if (cfg.features.egressGate) {
    ctx.on('llm/stream', (options, next) => {
      const iter = next();
      const sessionId = options?.sessionId;
      if (!sessionId) return iter;
      return egress.wrapStream(String(sessionId), iter);
    });
  }

  // ── 路由：一级标签 + 策略/禁言 + 环境消息判定；reject 即零模型调用 ──
  if (cfg.features.routing) {
    ctx.on('agent/pre-step', async (payload, next) => {
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
        const text = claimed
          .map((m) => (m?.content ?? []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n'))
          .join('\n');
        const isMentioned = String(text).includes('(@you)');
        // 入站镜像兜底：被 reject 的消息不会产生 user/message 事件，这里先落 raw_log
        for (const m of claimed) {
          const raw = (m?.content ?? []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
          if (!raw || isMetaText(raw) || isSystemNoise(raw)) continue;
          const norm = normalizeInbound(raw);
          if (!norm.current) continue;
          const who = norm.sender
            ? { userId: norm.sender.id, senderName: norm.sender.name, attribution: 'sender' }
            : parseSender(norm.current, binding);
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
              payload: norm.current,
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
          circuitOpen: !!embedder && vecReady && embedCircuit.isOpen('embed'),
          complete: makeComplete(ctx),
          random: Math.random,
        });
        recordRoute(sessionId, binding, decision.label, decision.reason);
        // 探索唤醒的话题先记账；反复出现才会升成关注点
        if (decision.reason === 'ambient-explore') {
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

  // ── 上下文注入：pre-step 里 await next() 后追加事实块（不依赖 agent.inject）──
  if (cfg.features.contextInject) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        if (decision?.kind !== 'enter') return decision;
        const sessionId = String(payload?.agent?.id ?? '');
        const binding = bindingFor(sessionId);
        if (!binding) return decision;
        const cctx = effectiveCfg().context;
        const prev = lastInjectBlock.get(sessionId) ?? { factBlock: '', ruleBlock: '', eventAt: 0 };
        const built = buildInjection({ db, binding, payload, cfg: cctx, prev });
        const { ruleBlock, factBlock, eventBlock, events } = built;

        // 增量注入：规则/事实只在内容变化时给；经历只给上次之后的新条目
        const { ruleDelta, factDelta, eventDelta, eventIds } = diffInjection({ built, prev, cfg: cctx });
        // 图片缓存命中：同一张图别再让模型看一遍
        let imageHint = '';
        try {
          const imgSrc = (payload.messages ?? [])
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
        const block = [ruleDelta, factDelta, eventDelta, imageHint].filter(Boolean).join('\n\n');
        if (!block) return decision;
        lastInjectBlock.set(sessionId, {
          ruleBlock: ruleBlock || prev.ruleBlock,
          factBlock: factBlock || prev.factBlock,
          eventIds,
        });
        try {
          if (effectiveCfg().diagnostics?.injectLog === false) throw new Error('disabled');
          const logPath = join(dirname(dbFile), 'inject.log');
          mkdirSync(dirname(logPath), { recursive: true });
          appendFileSync(
            logPath,
            JSON.stringify({
              at: new Date().toISOString(),
              conversation: binding.conversationKey,
              scope: binding.scope,
              facts: rows.length,
              events: events.length,
              factChars: factBlock.length,
              eventChars: eventBlock.length,
              factSent: factDelta ? factDelta.length : 0,
              eventsSent: newEvents.length,
              eventCharsSent: eventDelta ? eventDelta.length : 0,
            }) + '\n',
          );
        } catch {
          /* 诊断失败不影响注入 */
        }
        const msg = buildContextMessage(block);
        if (!isValidUserMessageShape(msg)) return decision;
        return { ...decision, messages: [...decision.messages, msg] };
      } catch (err) {
        log('warn', 'context-inject', { error: String(err?.message ?? err) });
        return decision;
      }
    });
  }

  // ── 巡检：低频，只报告不静默改 ──
  if (cfg.janitor.enabled) {
    const timer = setInterval(() => {
      try {
        const rep = runJanitor(db, { rawLogDays: cfg.retention?.rawLogDays ?? 0 });
        try { rep.attention = pruneAttention(db, { maxActive: cfg.attention?.maxActive ?? 80, expireDays: cfg.attention?.ttlDays ?? 30 }); } catch { /* ignore */ }
        try {
          rep.promoted = promoteCandidates(db, {
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

  // ── 只读状态页：/tide（仅本机） ──
  // 用 ctx.inject 延迟到 webServer 就绪再挂；web 服务重建时只重挂路由，
  // 不会把整个插件拆掉重来。
  if (cfg.features.statusPage !== false) {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        try {
          return sctx.webServer.register({
            kind: 'prefix',
            path: ROUTE,
            handler: createPluginHandler(db, { dbFile, cfg }),
          });
        } catch (err) {
          log('warn', 'plugin-route', { error: String(err?.message ?? err) });
          return () => {};
        }
      }, 'tide.status-page');
    });
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
  void backfillAttentionVectors();

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
      description: '读取结构化事实的候选集（含历史版本与状态），版本裁决由调用方处理。',
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

  if (cfg.features.routing) {
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

  if (cfg.features.egressGate) {
    tools.push(
      {
        name: 'stay_silent',
        description: '声明本轮不出站。调用后本轮正文一律丢弃，且立即结束本轮。',
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
  const guardTool = (fn) => async (args, exec) => {
    const id = exec?.agent?.id ? String(exec.agent.id) : '';
    if (!id || !bindingFor(id)) return { ok: false, reason: 'out-of-scope' };
    return fn(args, exec);
  };

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
  const registerTools = cfg.features.tools !== false;
  for (const def of visibleTools) {
    try {
      ctx.tools.register({ ...def, execute: guardTool(def.execute), isConcurrencySafe: () => true, when });
    } catch (err) {
      log('warn', 'tool-register', { name: def.name, error: String(err?.message ?? err) });
    }
  }

  log('info', 'ready', { tools: tools.length, egress: cfg.features.egressGate });
}
