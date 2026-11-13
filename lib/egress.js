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

    /** llm/stream 用：返回异步生成器，静默时丢弃正文。 */
    wrapStream(sessionId, iterable) {
      const bound = isBindable(sessionId);
      if (!bound || cfg.holdTextOnSilence === false) return iterable;
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
        const silent = toolNames.has(SILENT_TOOL);
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

/** 纯函数：从 tool-call 名集合判断本轮是否声明静默（供单测）。 */
export function isSilentCall(names) {
  return new Set(names).has(SILENT_TOOL);
}

export { SILENT_TOOL, REPLY_TOOL };
