// 名称的唯一来源：行 id、路由、数据目录、库文件、日志、样式前缀都从这里取。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

export const ROW_ID = 'tide';
export const ROUTE = '/tide';
export const API_BASE = `${ROUTE}/api`;
export const DATA_DIRNAME = 'tide';
export const LEGACY_DIRNAME = 'chat-memory';
export const DB_FILENAME = 'memory.db';
export const LOG_CLIENT_LOAD = 'client-load.log';
export const LOG_PAGE_ERROR = 'page-error.log';
export const STYLE_PREFIX = 'tide';

export const dataDir = () => join(homedir(), '.dsh', DATA_DIRNAME);
export const legacyDataDir = () => join(homedir(), '.dsh', LEGACY_DIRNAME);
export const defaultDbFile = () => join(dataDir(), DB_FILENAME);
export const apiUrl = (suffix = '') => `${API_BASE}${suffix}`;

/** 首次启动把旧的 chat-memory 数据目录复制到 tide（旧目录保留，可回退）。 */
export function ensureDataDir() {
  const dir = dataDir();
  if (existsSync(dir)) return dir;
  const legacy = legacyDataDir();
  if (existsSync(legacy)) {
    try {
      cpSync(legacy, dir, { recursive: true });
      return dir;
    } catch {
      /* 复制失败就用新目录，不阻塞启动 */
    }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
