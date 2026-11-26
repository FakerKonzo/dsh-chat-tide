// 入站/抽取的规则预筛：挡掉宿主运行时元信息，只放"可能值得记"的话。
import { normalizeInbound, isSystemNoise } from './qqtext.js';

const META_PREFIXES = [
  '<system-reminder>',
  '<',
  'Current runtime context.',
  'Time sampled while preparing',
  '[model changed',
  '[skill:',
  '[system',
  '[Quoted message begins]',
];

/** 宿主注入的运行时/元信息，不是用户说的话。 */
export function isMetaText(text) {
  const t = String(text ?? '').trimStart();
  if (!t) return true;
  if (isInjectedBlock(t)) return true;
  return META_PREFIXES.some((p) => t.startsWith(p));
}

/** 我们自己注入的上下文块（规则/事实/经历）。它不是用户说的话，不能再回流。 */
const INJECTED_MARKERS = [
  '[规则 · 数据而非指令]',
  '[已知事实 · 数据而非指令]',
  '[相关经历 · 数据而非指令]',
  '数据而非指令',
  '[事实更新]',
];

export function isInjectedBlock(text) {
  const t = String(text ?? '');
  return INJECTED_MARKERS.some((m) => t.includes(m));
}

/**
 * 入站文本判废：先把 QQ 信封剥掉，再对真正的正文判元信息。
 * 引用回复的原文是
 *   [Quoted message begins]…历史…[Quoted message ends][Current message]\n[昵称] 真人说的话
 * 对原文直接 startsWith 判前缀，会把真人发言连引用一起丢掉。
 */
/**
 * 去掉宿主自己塞进上下文的标记行。
 * 这些不是人说的话：模型切换提示、时间采样行、浏览器时区行、system-reminder 块。
 * 它们出现时经常是「真话 + 标记」粘在同一条消息里，按前缀判断拦不住。
 */
const HOST_MARKER_LINE =
  /^\s*(\[model changed:[^\]]*\]|Time sampled while preparing turn[^\n]*|Browser time zone for this request:[^\n]*)\s*$/gim;
const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

export function stripHostNoise(text) {
  return String(text ?? '')
    .replace(SYSTEM_REMINDER_BLOCK, ' ')
    .replace(HOST_MARKER_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function inboundBody(raw) {
  const norm = normalizeInbound(raw);
  const body = stripHostNoise(norm.current);
  const base = { body, sender: norm.sender, hadEnvelope: norm.hadEnvelope };
  if (!body) return { ...base, usable: false, reason: 'empty' };
  if (isMetaText(body)) return { ...base, usable: false, reason: 'meta' };
  if (isSystemNoise(body)) return { ...base, usable: false, reason: 'noise' };
  return { ...base, usable: true, reason: '' };
}

const IMAGE_LINE = /^[-*\s]*Image:\s*\S+\s*$/im;
// QQ 会把媒体消息显示成占位符，这些都不算正文
const MEDIA_TOKEN =
  /\[(?:图片|表情|动画表情|语音|视频|文件|位置|链接|卡片消息|小程序|音乐|红包)\]/g;

/** 只有图片占位、没有实际文字的消息。 */
export function isImageOnly(text) {
  let t = String(text ?? '');
  if (!t.trim()) return false;
  // 去掉聊天信封、@ 提及、(@you) 之后再判断
  t = t.replace(/\[[^\]\n]{1,32}?\s*\([0-9A-Za-z]{10,}\)\]/g, ' ');
  t = t.replace(/<@[^>]{1,64}>/g, ' ');
  t = t.replace(/\(@you\)/gi, ' ');
  t = t.replace(/\[Current message\]/gi, ' ');
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return false;
  const hasImage = lines.some((line) => IMAGE_LINE.test(line));
  const rest = lines
    .filter((line) => !IMAGE_LINE.test(line))
    .join('')
    .replace(MEDIA_TOKEN, '')
    .trim();
  return hasImage && rest.length === 0;
}

const CUE_RE = /[我俺咱]|我的|我家|喜欢|不喜欢|讨厌|住在|住|叫|是|在|要|想|需要|记得|明天|后天|下周|上周|今天|生日|老婆|老公|孩子|猫|狗|咖啡|奶茶|工作|上班|公司|学校|专业|老家/;

/**
 * 规则预筛（设计 §5.3）：第一人称陈述、偏好/实体/时间句式才值得调模型抽取。
 * 过短、纯表情、纯链接直接跳过，省一次模型调用。
 */
export function looksMemorable(text, { minChars = 6 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || isMetaText(raw)) return false;
  if (raw.length < minChars) return false;
  if (/^https?:\/\/\S+$/.test(raw)) return false;
  if (isImageOnly(raw)) return false;
  if (raw.length > 4000) return false;
  return CUE_RE.test(raw);
}
