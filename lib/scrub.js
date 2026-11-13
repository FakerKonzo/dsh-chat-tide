// 标识脱敏：把长串 id/openid 之类换成占位，避免写进关注点或事实值
const LONG_ID = /\b[0-9A-Za-z_-]{24,}\b/g;
const ENVELOPE = /\[[^\]\n]{1,32}?\s*\(([0-9A-Za-z]{10,})\)\]/g;
const MENTION = /<@[^>]{1,64}>/g;

/** 去掉聊天信封，并把长串标识替换成 <id>。 */
export function scrubIdentifiers(text) {
  let t = String(text ?? '');
  t = t.replace(ENVELOPE, ' ');
  t = t.replace(MENTION, ' ');
  t = t.replace(LONG_ID, '<id>');
  return t.replace(/\s+/g, ' ').trim();
}

/** 体检用：找出仍然含长串标识的文本。 */
export function findIdentifierLeaks(text) {
  const t = String(text ?? '');
  const hits = [];
  const re = /\b[0-9A-Fa-f]{24,}\b/g;
  let m;
  while ((m = re.exec(t))) hits.push(m[0]);
  return hits;
}
