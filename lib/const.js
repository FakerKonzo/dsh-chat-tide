// 名称的唯一来源：凡是「行 id 相关」的路径都用 ROW_ID，凡是「品牌」都用 Tide。
// 路由 / 数据目录 / 库文件 / 日志文件名 / 样式前缀，改动只改这里。
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROW_ID = 'chat-memory';
export const ROUTE = '/chat-memory';
export const API_BASE = `${ROUTE}/api`;
export const DATA_DIRNAME = 'chat-memory';
export const DB_FILENAME = 'memory.db';
export const LOG_CLIENT_LOAD = 'client-load.log';
export const LOG_PAGE_ERROR = 'page-error.log';
export const STYLE_PREFIX = 'tide';

export const dataDir = () => join(homedir(), '.dsh', DATA_DIRNAME);
export const defaultDbFile = () => join(dataDir(), DB_FILENAME);
export const apiUrl = (suffix = '') => `${API_BASE}${suffix}`;
