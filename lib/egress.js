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
     * gate=true 时才做静默挂起：要判断这一轮有没有调拒答工具，就得先看完再发。
     * 注意：这里只认工具调用，不去猜正文有没有意义——那是上游的事。
     */
    wrapStream(sessionId, iterable, { gate = true } = {}) {
      if (!isBindable(sessionId)) return iterable;
      // 只在需要「静默时挡正文」时才缓冲；显式关掉就直通，顺序完全不变。
      const holdForSilence = gate && cfg.holdTextOnSilence !== false;
      if (!holdForSilence) return iterable;
      return (async function* () {
        // 首段正文之后按原顺序回放，之前的思考和进度仍可实时显示。
        const buffered = [];
        const toolNames = new Set();
        let holding = false;
        for await (const chunk of iterable) {
          if (chunk.type === 'tool-call-delta' && chunk.name) toolNames.add(chunk.name);
          if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.name) {
            toolNames.add(chunk.block.name);
          }
          holding ||= chunk.type === 'text-delta' || chunk.blockType === 'text' || chunk.block?.type === 'text';
          if (holding) buffered.push(chunk);
          else yield chunk;
        }
        // run_code 中的工具只有执行时才知道。此步只交付工具调用，下一步再发最终回复。
        const silent = toolNames.has(SILENT_TOOL) || toolNames.has('run_code') || current(sessionId).silent;
        for (const chunk of buffered) {
          if (silent && chunk.type === 'text-delta') continue;
          if (silent && chunk.type === 'block-end' && chunk.block?.type === 'text') {
            // 丢掉正文，只留一个空文本块，避免下游拿到半截内容
            yield { ...chunk, block: { ...chunk.block, text: '' } };
            continue;
          }
          yield chunk;
        }
      })();
    },
  };
}


/** 纯函数：从 tool-call 名集合判断本轮是否声明静默（供单测）。 */
export function isSilentCall(names) {
  return new Set(names).has(SILENT_TOOL);
}

export { SILENT_TOOL, REPLY_TOOL };
