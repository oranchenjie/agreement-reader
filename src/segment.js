/**
 * 条款切分（Segmentation）。
 *
 * 为什么不用模型切分：一是贵，二是不可复现。切分是纯结构性问题，用确定性规则解决，
 * 好处是给每个条款一个**稳定的 id 与字符偏移**，从而支撑：
 *   - 前端点击条款 → 高亮原文
 *   - 模型引文核验（引文必须能在对应条款里找到）
 *   - 长协议分片并行分析时，结果能合并回同一条款
 *
 * 现实中的协议格式极其混乱（编号体系五花八门、网页抓取后换行丢失），因此这里设计为
 * 「多级降级」：能识别结构就按结构切，识别不出来就按段落聚合成等长块。
 */

/** 编号/标题识别规则，按置信度从高到低 */
const HEADING_RULES = [
  // 第十二条 / 第三章 / 第 4 节
  { id: 'cn-article', re: /^第\s*[一二三四五六七八九十百千零〇两0-9]{1,12}\s*[章节條条款項项编篇]/ },
  // 一、 二、
  { id: 'cn-ordinal', re: /^[一二三四五六七八九十]{1,4}\s*[、．.]\s*/ },
  // 3.2.1 标题
  { id: 'dotted', re: /^\d{1,3}(?:\.\d{1,4}){1,5}(?:\s|[、．.]|\s*$)/ },
  // 1. / 2、 / 3)
  { id: 'arabic', re: /^\d{1,3}\s*[、．.)）]\s*/ },
  // (a) / （1） / (iv)
  { id: 'paren', re: /^[（(]\s*(?:[a-zA-Z]{1,3}|\d{1,3}|[一二三四五六七八九十]{1,3})\s*[)）]\s*/ },
  // Section 3 / Article IV
  { id: 'en-section', re: /^(?:Section|Article|Clause|Part|Schedule|Annex|Appendix)\s+[0-9IVXLC]+/i },
  // Markdown 标题（HTML 提取常见）
  { id: 'md', re: /^#{1,6}\s+\S/ },
]

const SENTENCE_END = /[。！？；：.?!;:）)]\s*$/

function toLines(text) {
  const out = []
  let idx = 0
  for (const raw of text.split('\n')) {
    out.push({ text: raw, start: idx, end: idx + raw.length })
    idx += raw.length + 1
  }
  return out
}

/** 判断某行是否为标题，返回规则 id 或 null */
function matchHeading(line) {
  const t = line.trim()
  if (!t) return null
  // 标题一般不会太长；超过 120 字符的基本是正文
  if (t.length > 120) return null
  for (const rule of HEADING_RULES) {
    if (rule.re.test(t)) return rule.id
  }
  return null
}

/**
 * 低置信度标题启发：短行 + 不以句末标点结尾 + 下一行明显更长。
 * 用于没有编号体系、但用小标题分段的协议。
 */
function looksLikeBareHeading(line, nextLine) {
  const t = line.trim()
  if (!t) return false
  if (t.length > 40) return false
  if (SENTENCE_END.test(t)) return false
  if (!nextLine) return false
  const n = nextLine.trim()
  if (!n) return false
  return n.length > t.length * 1.6 && n.length > 40
}

/**
 * 主入口。
 *
 * @param {string} text 归一化后的正文
 * @param {{ minClauseChars?: number, maxClauses?: number, targetChunkChars?: number, bareHeadings?: boolean }} [opts]
 * @returns {{
 *   clauses: Array<{ id:string, index:number, heading:string, text:string, start:number, end:number, chars:number, headingRule:string|null }>,
 *   stats: { strategy:string, count:number, totalChars:number, headingRules:Record<string,number> }
 * }}
 */
export function segmentClauses(text, opts = {}) {
  const minClauseChars = opts.minClauseChars ?? 100
  const maxClauses = opts.maxClauses ?? 300
  const targetChunkChars = opts.targetChunkChars ?? 900
  const bareHeadings = opts.bareHeadings ?? true

  const src = String(text ?? '')
  if (!src.trim()) {
    return { clauses: [], stats: { strategy: 'empty', count: 0, totalChars: 0, headingRules: {} } }
  }

  const lines = toLines(src)
  const headingRules = {}

  /** @type {Array<{startLine:number,endLine:number,rule:string|null,headingLine:number}>} */
  const rawBlocks = []
  let current = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let rule = matchHeading(line.text)
    if (!rule && bareHeadings && looksLikeBareHeading(line.text, lines[i + 1]?.text)) {
      rule = 'bare'
    }
    // 行中间的小标题（如「3.2 数据共享 我们可能…」）也视为条款起点
    if (rule) {
      if (current) rawBlocks.push(current)
      current = { startLine: i, endLine: i, rule, headingLine: i }
      headingRules[rule] = (headingRules[rule] ?? 0) + 1
    } else {
      if (!current) {
        current = { startLine: i, endLine: i, rule: null, headingLine: i }
      } else {
        current.endLine = i
      }
    }
  }
  if (current) rawBlocks.push(current)

  // 去掉纯空白块
  let blocks = rawBlocks.filter((b) => src.slice(lines[b.startLine].start, lines[b.endLine].end).trim().length > 0)

  let strategy = Object.keys(headingRules).length > 0 ? 'structure' : 'paragraph'

  // 结构切分失败（只有 1 块但文本很长）→ 段落聚合法
  if (blocks.length < 2 && src.length > targetChunkChars * 1.5) {
    blocks = groupByParagraphs(lines, targetChunkChars)
    strategy = 'paragraph'
  }

  // 只合并「低置信度标题」产生的短块（裸标题/无标题前导）。
  // 像「第十二条」「3.2」这类明确编号是真实的条款边界，绝不能因为短就合并掉。
  if (strategy === 'structure') {
    blocks = mergeLowConfidence(blocks, lines, minClauseChars)
  }

  // 块数过多 → 合并最短的相邻块
  if (blocks.length > maxClauses) {
    blocks = reduceToMax(blocks, lines, maxClauses)
  }

  const clauses = blocks.map((b, i) => {
    // 关键不变量：clause.start / clause.end 必须**紧贴** clause.text。
    // 若只对 text 做 trim 而保留未修剪的区间，所有基于 clause.start 的相对偏移
    // 都会整体错位，前端高亮就会偏移。因此这里同时收紧区间。
    const rawStart = lines[b.startLine].start
    const rawEnd = lines[b.endLine].end
    const raw = src.slice(rawStart, rawEnd)
    const lead = raw.length - raw.trimStart().length
    const trail = raw.length - raw.trimEnd().length
    const start = rawStart + lead
    const end = Math.max(start, rawEnd - trail)
    const body = src.slice(start, end)

    const headingLineIdx = b.headingLine ?? b.startLine
    const firstLine = lines[headingLineIdx].text.trim()
    let heading = ''
    if (b.rule) {
      heading = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
    } else {
      // 无编号：用首句做展示标题
      const firstSentence = firstLine.split(/(?<=[。！？.!?])/)[0] ?? firstLine
      heading = firstSentence.length > 60 ? firstSentence.slice(0, 60) + '…' : firstSentence
    }
    return {
      id: `c${i + 1}`,
      index: i,
      heading: heading || `第 ${i + 1} 段`,
      text: body,
      start,
      end,
      chars: body.length,
      headingRule: b.rule,
    }
  }).filter((c) => c.text.length > 0)

  // 重排 id，保证连续
  clauses.forEach((c, i) => {
    c.index = i
    c.id = `c${i + 1}`
  })

  return {
    clauses,
    stats: {
      strategy,
      count: clauses.length,
      totalChars: src.length,
      headingRules,
    },
  }
}

function groupByParagraphs(lines, targetChars) {
  const blocks = []
  let cur = null
  let curChars = 0

  const push = () => {
    if (cur) blocks.push(cur)
    cur = null
    curChars = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isBlank = line.text.trim() === ''
    if (isBlank && curChars >= targetChars) {
      push()
      continue
    }
    if (!cur) {
      cur = { startLine: i, endLine: i, rule: null, headingLine: i }
      curChars = 0
    } else {
      cur.endLine = i
    }
    curChars += line.text.length
    if (curChars >= targetChars && isBlank) push()
  }
  push()
  return blocks.filter((b) => lines[b.startLine].text.trim() !== '' || b.endLine > b.startLine)
}

function blockChars(b, lines) {
  const start = lines[b.startLine].start
  const end = lines[b.endLine].end
  return end - start
}

/**
 * 合并低置信度块。
 *
 * 只有两类块会被合并：裸标题（bare）与文档前导（rule === null）。
 * 明确的编号标题（第十二条 / 3.2 / Section 4 …）一律保留，
 * 因为它们几乎必然是真实条款，合并会破坏条款边界与引文归属。
 */
function mergeLowConfidence(blocks, lines, minChars) {
  let out = []
  for (const b of blocks) {
    const lowConfidence = b.rule === null || b.rule === 'bare'
    const isShort = blockChars(b, lines) < minChars
    if (lowConfidence && isShort && out.length > 0) {
      out[out.length - 1].endLine = b.endLine
    } else {
      out.push({ ...b })
    }
  }

  // 文档开头的短前导（通常只有标题行）并入第一个真实条款，
  // 避免生成一个只含标题的“条款”，同时保留标题作为文档上下文。
  if (out.length > 1 && out[0].rule === null && blockChars(out[0], lines) < 80) {
    const [head, next, ...rest] = out
    out = [
      { startLine: head.startLine, endLine: next.endLine, rule: next.rule, headingLine: next.headingLine ?? next.startLine },
      ...rest,
    ]
  }
  return out
}

function reduceToMax(blocks, lines, maxClauses) {
  const work = blocks.map((b) => ({ ...b }))
  while (work.length > maxClauses) {
    // 找最短的相邻对合并
    let bestIdx = 0
    let bestSize = Infinity
    for (let i = 0; i < work.length - 1; i++) {
      const size = blockChars(work[i], lines) + blockChars(work[i + 1], lines)
      if (size < bestSize) {
        bestSize = size
        bestIdx = i
      }
    }
    work[bestIdx] = {
      startLine: work[bestIdx].startLine,
      endLine: work[bestIdx + 1].endLine,
      rule: work[bestIdx].rule,
      headingLine: work[bestIdx].headingLine ?? work[bestIdx].startLine,
    }
    work.splice(bestIdx + 1, 1)
  }
  return work
}
