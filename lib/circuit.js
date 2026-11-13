// 熔断：连续失败打开、冷却后半开、成功关闭。与预算跳过分开统计。
export function createCircuit({ threshold = 5, cooldownMs = 60_000, now = () => Date.now() } = {}) {
  const state = new Map(); // name -> { failures, openedAt }

  function get(name) {
    let s = state.get(name);
    if (!s) {
      s = { failures: 0, openedAt: 0 };
      state.set(name, s);
    }
    return s;
  }

  return {
    isOpen(name) {
      const s = get(name);
      if (!s.openedAt) return false;
      if (now() - s.openedAt >= cooldownMs) {
        // 半开：放一个请求试探
        s.openedAt = 0;
        s.failures = 0;
        return false;
      }
      return true;
    },
    recordFailure(name) {
      const s = get(name);
      s.failures += 1;
      if (s.failures >= threshold && !s.openedAt) s.openedAt = now();
      return s.failures >= threshold;
    },
    recordSuccess(name) {
      const s = get(name);
      s.failures = 0;
      s.openedAt = 0;
    },
    snapshot(name) {
      const s = get(name);
      return { ...s, open: this.isOpen(name) };
    },
  };
}
