// 名称的唯一来源：行 id、路由、数据目录、库文件、日志、样式前缀都从这里取。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const ROW_ID = 'tide';
export const ROUTE = '/tide';
export const API_BASE = `${ROUTE}/api`;
export const DATA_DIRNAME = 'tide';
export const DB_FILENAME = 'memory.db';
export const LOG_CLIENT_LOAD = 'client-load.log';
export const LOG_PAGE_ERROR = 'page-error.log';
export const STYLE_PREFIX = 'tide';

export const dataDir = () => join(homedir(), '.dsh', DATA_DIRNAME);
export const defaultDbFile = () => join(dataDir(), DB_FILENAME);
export const apiUrl = (suffix = '') => `${API_BASE}${suffix}`;

/** 确保数据目录存在。 */
export function ensureDataDir() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
