// 本机 HTTP 的共用小工具：Host/Origin 解析与请求体上限。
// 单独拎出来，避免 api.js 与 status-page.js 互相 import 形成循环。

/** 请求体硬上限：1 MiB。超了直接 413，别让本机口子被灌爆内存。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** 允许访问的本机主机名（不含端口）。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 从 Host / Origin 头里解析主机名，正确处理 IPv6 方括号与端口：
 *   [::1]:53322 → ::1；[::1] → ::1；127.0.0.1:1234 → 127.0.0.1；localhost → localhost
 * 解析不出来时返回空串。
 */
export function parseHostName(hostHeader) {
  const raw = String(hostHeader ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    // IPv6 字面量：[::1]:port 或 [::1]
    const end = raw.indexOf(']');
    return (end === -1 ? raw.slice(1) : raw.slice(1, end)).toLowerCase();
  }
  // 没有方括号：多于一个冒号说明是裸 IPv6（如 ::1），整段就是主机名
  const colons = (raw.match(/:/g) || []).length;
  return (colons > 1 ? raw : raw.split(':')[0]).toLowerCase();
}

/** 解析出的主机名是否属于本机。 */
export function isLocalHostName(name) {
  return LOCAL_HOSTS.has(String(name ?? '').trim().toLowerCase());
}

/** 本机 Host 头校验（IPv4 / localhost / IPv6）。 */
export function isLocalHostHeader(hostHeader) {
  return isLocalHostName(parseHostName(hostHeader));
}

/** 从 Origin 头解析主机名；解析不出（含 "null"）返回空串，按跨站处理。 */
export function parseOriginHost(originHeader) {
  const raw = String(originHeader ?? '').trim();
  if (!raw || raw === 'null') return '';
  try {
    // URL.hostname 对 IPv6 会带方括号，交给 parseHostName 归一
    return parseHostName(new URL(raw).hostname);
  } catch {
    return '';
  }
}
