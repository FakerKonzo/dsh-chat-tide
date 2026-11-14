// 入站/抽取的规则预筛：挡掉宿主运行时元信息，只放"可能值得记"的话。
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

const IMAGE_LINE = /^[-*\s]*Image:\s*\S+\s*$/im;

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
  const rest = lines.filter((line) => !IMAGE_LINE.test(line)).join('').trim();
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
