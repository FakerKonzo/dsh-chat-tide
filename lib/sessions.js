// 只读列出最近会话：从 ~/.dsh/sessions/<workspace>/<id>/ 目录 + 投影缓存取标题
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSIONS_ROOT = () => join(homedir(), '.dsh', 'sessions');
const PROJ_ROOT = () => join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');

function projection(uuid) {
  try {
    const j = JSON.parse(readFileSync(join(PROJ_ROOT(), uuid + '.json'), 'utf8'));
    const record = j?.record ?? {};
    const title = record?.rows?.title?.val;
    const cwd = record?.identity?.cwd;
    return {
      title: typeof title === 'string' ? title : null,
      cwd: typeof cwd === 'string' ? cwd : null,
    };
  } catch {
    return { title: null, cwd: null };
  }
}

/** 工作区目录名是路径的编码形态：--D-Projects-QQBot-- → D:\\Projects\\QQBot */
function decodeWorkspace(name) {
  const parts = String(name).replace(/^-+|-+$/g, '').split('-').filter(Boolean);
  if (parts.length < 2) return null;
  const drive = parts[0];
  return drive.length === 1 ? drive + ':\\' + parts.slice(1).join('\\') : parts.join('\\');
}

/** 列出最近会话，按目录修改时间倒序。只读，不改任何文件。 */
export function listRecentSessions(limit = 60) {
  const out = [];
  let workspaces = [];
  try {
    workspaces = readdirSync(SESSIONS_ROOT(), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    const wsPath = join(SESSIONS_ROOT(), ws.name);
    let entries = [];
    try {
      entries = readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const e of entries) {
      let at = 0;
      try {
        at = statSync(join(wsPath, e.name)).mtimeMs;
      } catch {
        continue;
      }
      const uuid = e.name.startsWith('session-') ? e.name.slice('session-'.length) : e.name;
      const meta = projection(uuid);
      out.push({
        id: e.name,
        title: meta.title ?? null,
        cwd: meta.cwd ?? decodeWorkspace(ws.name),
        updatedAt: Math.round(at),
        workspace: ws.name,
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}
