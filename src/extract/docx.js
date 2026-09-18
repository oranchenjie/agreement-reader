/**
 * DOCX（Word 2007+）文本提取。
 *
 * 协议以 Word 文档流传的情况很常见。DOCX 是一个 ZIP 包，正文在 word/document.xml。
 * 这里不引入 XML 解析库，用手写扫描器按 w:p（段落）/ w:t（文本运行）结构抽取，
 * 并保留列表项与换行信息。
 */
import { listZipEntries, readZipEntry, readZipEntryByName } from './zip.js'

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return m
        }
      }
      return m
    }
    const named = ENTITIES[body]
    return named !== undefined ? named : m
  })
}

/** 从 document.xml 抽取段落文本 */
export function docxXmlToText(xml) {
  const paragraphs = []
  // 逐个 <w:p ...>...</w:p> 处理（含自闭合 <w:p/>）
  const pRe = /<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g
  let m
  let matched = false

  while ((m = pRe.exec(xml)) !== null) {
    matched = true
    const inner = m[1] ?? ''
    let text = ''

    // 按出现顺序处理 w:t / w:tab / w:br / w:cr
    const tokenRe = /<w:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>|<w:cr(?:\s[^>]*)?\/>/g
    let t
    while ((t = tokenRe.exec(inner)) !== null) {
      if (t[0].startsWith('<w:t')) {
        text += decodeEntities(t[1] ?? '')
      } else if (t[0].startsWith('<w:tab')) {
        text += ' '
      } else {
        text += '\n'
      }
    }

    // 列表项标记
    const isListItem = /<w:numPr\b/.test(inner)
    text = text.replace(/\s+$/g, '')
    if (!text.trim()) {
      paragraphs.push('')
      continue
    }
    paragraphs.push(isListItem ? `• ${text.trim()}` : text.trim())
  }

  // 兜底：没有 w:p 结构时，直接把所有 w:t 拼起来
  if (!matched) {
    const texts = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((x) => decodeEntities(x[1]))
    return texts.join(' ')
  }

  // 把连续空段落折叠为单个段落分隔
  return paragraphs
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 提取核心属性里的标题 */
function readCoreTitle(buf) {
  try {
    const xml = readZipEntryByName(buf, 'docProps/core.xml')?.toString('utf8')
    if (!xml) return ''
    const m = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(xml)
    return m ? decodeEntities(m[1]).trim() : ''
  } catch {
    return ''
  }
}

/**
 * @param {Buffer} buf
 * @returns {{ text:string, title:string, meta:{ parts:string[], warnings:string[] } }}
 */
export function extractDocxText(buf) {
  const warnings = []
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    // 不是 ZIP：很可能是旧版 .doc（OLE2 复合文档）
    if (buf.length >= 8 && buf.readUInt32LE(0) === 0xd0cf11e0) {
      return {
        text: '',
        title: '',
        meta: { parts: [], warnings: ['检测到旧版 .doc（二进制）格式，暂不支持。请另存为 .docx 或复制正文后粘贴。'] },
      }
    }
    return { text: '', title: '', meta: { parts: [], warnings: ['不是有效的 DOCX 文件。'] } }
  }

  let entries
  try {
    entries = listZipEntries(buf)
  } catch (err) {
    return { text: '', title: '', meta: { parts: [], warnings: [`DOCX 解析失败：${err.message}`] } }
  }

  const parts = []
  const wanted = entries
    .filter((e) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(e.name))
    // document 优先
    .sort((a, b) => (a.name === 'word/document.xml' ? -1 : b.name === 'word/document.xml' ? 1 : 0))

  const usedParts = []
  for (const entry of wanted) {
    try {
      const xml = readZipEntry(buf, entry).toString('utf8')
      const text = docxXmlToText(xml)
      if (text.trim()) {
        parts.push(text)
        usedParts.push(entry.name)
      }
    } catch (err) {
      warnings.push(`读取 ${entry.name} 失败：${err.message}`)
    }
  }

  if (parts.length === 0) {
    warnings.push('DOCX 中未找到可提取的正文文本，可能内容全部是图片（扫描件）。')
  } else if (!usedParts.includes('word/document.xml')) {
    warnings.push('未找到主文档部件，仅提取到页眉/页脚内容。')
  }

  return {
    text: parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    title: readCoreTitle(buf),
    meta: { parts: usedParts, warnings },
  }
}
