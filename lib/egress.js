// 出站闸门：generation 状态机 + llm/stream 文本挂起。
const SILENT_TOOL = 'stay_silent';
const REPLY_TOOL = 'reply';

export function createEgress({ isBindable, cfg, log }) {
  /** sessionId -> 当前 generation */
  const gens = new Map();

  const newGen = (sessionId, turn) => ({ sessionId, turn, id: `${sessionId}:${turn}`, silent: false, replied: false });
  const current = (sessionId) => gens.get(sessionId) ?? newGen(sessionId, 0);

  return {
    /** session/event 里调用：turn/start 开新 generation，turn/end 收尾。 */
    observe(sessionId, event) {
      if (!isBindable(sessionId)) return;
      if (event.type === 'turn/start') {
        gens.set(sessionId, newGen(sessionId, event.data?.turn ?? 0));
      } else if (event.type === 'turn/end') {
        const g = gens.get(sessionId);
        if (g?.silent) log?.('info', 'egress', { sessionId, generation: g.id, status: 'SILENT' });
        gens.delete(sessionId);
      }
    },

    get(sessionId) {
      return current(sessionId);
    },

    declareSilent(sessionId) {
      const g = current(sessionId);
      g.silent = true;
      gens.set(sessionId, g);
      return g;
    },

    declareReply(sessionId) {
      const g = current(sessionId);
      g.replied = true;
      gens.set(sessionId, g);
      return g;
    },

    /**
     * llm/stream 用：返回异步生成器。
     * gate=true 时才做静默挂起（需要缓冲整段正文）；括号旁白无论闸门开关都拦。
     */
    wrapStream(sessionId, iterable, { gate = true } = {}) {
      const bound = isBindable(sessionId);
      if (!bound) return iterable;
      // 要拦「整条只是括号旁白」就必须先看完这条消息，所以默认缓冲；显式关掉就直通
      const holdForSilence = gate && cfg.holdTextOnSilence !== false;
      return (async function* () {
        const textDeltas = [];
        const textEnds = [];
        const toolNames = new Set();
        for await (const chunk of iterable) {
          if (chunk.type === 'text-delta') {
            textDeltas.push(chunk);
            continue;
          }
          if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
            textEnds.push(chunk);
            continue;
          }
          if (chunk.type === 'tool-call-delta' && chunk.name) toolNames.add(chunk.name);
          if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.name) {
            toolNames.add(chunk.block.name);
          }
          yield chunk;
        }
        const silent =
          (holdForSilence && toolNames.has(SILENT_TOOL)) ||
          isNarrationOnly(textDeltas.map((d) => d.text ?? '').join(''));
        if (silent) {
          // 丢掉正文，只保留一个空文本块，避免下游拿到半截内容
          for (const end of textEnds) yield { ...end, block: { ...end.block, text: '' } };
          return;
        }
        for (const d of textDeltas) yield d;
        for (const end of textEnds) yield end;
      })();
    },
  };
}

/**
 * 整条正文只是括号里的旁白，例如「（图跳过）」「（不看了）」。
 * 这类输出等于一条消息，群里看得见，比不回更显眼；判定条件是结构化的，
 * 不会误伤含正文的回复。多个括号连在一起也算。
 */
export function isNarrationOnly(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (!/^[（(]/.test(t) || !/[）)]$/.test(t)) return false;
  // 去掉所有括号片段后必须什么都不剩
  return t.replace(/[（(][^（()）]*[）)]/g, '').trim() === '';
}

/** 纯函数：从 tool-call 名集合判断本轮是否声明静默（供单测）。 */
export function isSilentCall(names) {
  return new Set(names).has(SILENT_TOOL);
}

export { SILENT_TOOL, REPLY_TOOL };
