/**
 * 文本归一化。
 *
 * 目的：把来自网页/PDF/Word/粘贴板的五花八门文本，收敛成一份「干净且字符偏移可信」的正文。
 * 关键约束：**归一化后的文本就是唯一事实来源**——分段偏移、模型引文、前端高亮全部基于它，
 * 因此这里做过的每一处改写都必须是确定性的、可重复的。
 */

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g
const SOFT_HYPHEN = /\u00AD/g
// 各类 Unicode 空白 → 普通空格（含 NBSP、窄空格、全角空格）
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
// 全角字母与数字 → 半角（保留全角标点，中文语境下 ，。：；！？ 是有意义的）
const FULLWIDTH_ALNUM = /[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g

/** 常见页眉页脚/页码噪声行 */
const NOISE_LINE_PATTERNS = [
  /^\s*[-—–]?\s*\d{1,4}\s*[-—–]?\s*$/, // 纯页码
  /^\s*(第\s*\d+\s*页|共\s*\d+\s*页|Page\s+\d+(\s+of\s+\d+)?)\s*$/i,
  /^\s*[\d./-][\d\s./-]{0,9}\s*$/, // 纯符号/数字行（必须含至少一个非空白字符）
]

export function toHalfWidthAlnum(ch) {
  const code = ch.charCodeAt(0)
  if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xfee0)
  if (code >= 0xff21 && code <= 0xff3a) return String.fromCharCode(code - 0xfee0)
  if (code >= 0xff41 && code <= 0xff5a) return String.fromCharCode(code - 0xfee0)
  return ch
}

/**
 * 英文断词还原：行尾连字符 + 下一行小写字母 → 合并。
 * 只在「连字符位于行尾」且「下一行首为小写字母」时生效，避免破坏 "well-known" 这类词。
 */
function dehyphenate(text) {
  return text.replace(/([A-Za-z])-\n(?=[a-z])/g, '$1')
}

/**
 * 把超长单行切成句子级伪段落。
 * 有些网页抓取结果会是「一整块没有换行的文本」，直接按行分段会得到 1 段，
 * 这里按中英文句末标点补上换行，让后续分段与分片有合理粒度。
 */
function breakLongLines(text, threshold = 600) {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= threshold) return line
      // 在句末标点后断行（保留标点），限制单行长度
      const parts = []
      let buf = ''
      for (const ch of line) {
        buf += ch
        if (/[。！？；!?;]/.test(ch) && buf.length >= 120) {
          parts.push(buf)
          buf = ''
        }
      }
      if (buf) parts.push(buf)
      return parts.join('\n')
    })
    .join('\n')
}

/**
 * @param {string} raw
 * @returns {{ text: string, stats: { inputChars: number, outputChars: number, removedNoiseLines: number, dehyphenated: boolean } }}
 */
export function normalizeText(raw) {
  const input = String(raw ?? '')
  let text = input

  text = text.normalize('NFC')
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(ZERO_WIDTH, '')
  text = text.replace(SOFT_HYPHEN, '')
  text = text.replace(UNICODE_SPACES, ' ')
  text = text.replace(FULLWIDTH_ALNUM, toHalfWidthAlnum)
  text = text.replace(/\t/g, ' ')
  // 去掉行尾空白
  text = text
    .split('\n')
    .map((l) => l.replace(/[ ]+$/g, ''))
    .join('\n')

  const beforeDehyph = text
  text = dehyphenate(text)
  const dehyphenated = text !== beforeDehyph

  text = breakLongLines(text)

  // 去除噪声行。注意：空行是段落分隔符，必须保留，
  // 否则无编号结构的协议会被合并成一整块，段落聚合切分随之失效。
  let removedNoiseLines = 0
  text = text
    .split('\n')
    .filter((line) => {
      if (line.trim() === '') return true
      const isNoise = NOISE_LINE_PATTERNS.some((re) => re.test(line))
      if (isNoise) removedNoiseLines++
      return !isNoise
    })
    .join('\n')

  // 连续空格压缩（不动换行）
  text = text.replace(/[ ]{2,}/g, ' ')
  // 3 个以上换行压成 2 个
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.trim()

  return {
    text,
    stats: {
      inputChars: input.length,
      outputChars: text.length,
      removedNoiseLines,
      dehyphenated,
    },
  }
}

/**
 * 引文核验用的宽松指纹：忽略所有空白与常见标点差异，只保留「实义字符」。
 * 用于判断模型引用的原文是否真实存在（容忍空格/换行/全半角差异）。
 */
export function fingerprint(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\s\u00A0\u3000]+/g, '')
    .replace(/[“”"'‘’`]/g, '"')
    .replace(/[，,]/g, ',')
    .replace(/[。．.]/g, '.')
    .replace(/[；;]/g, ';')
    .replace(/[：:]/g, ':')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/[—–－-]/g, '-')
    .toLowerCase()
}

/** 估算 token 数（中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token），用于分片预算。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/g) || []).length
  const rest = s.length - cjk
  return Math.ceil(cjk + rest / 3.5)
}
