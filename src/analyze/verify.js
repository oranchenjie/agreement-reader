/**
 * 引文核验（Quote Verification）。
 *
 * 这是让报告「可核对」的关键一步：模型给出的每条结论都必须附带原文片段，
 * 这里在本地判断该片段是否真实存在于原文中，并计算出精确的字符区间，
 * 供前端高亮定位。核验不通过的条目直接丢弃——宁缺毋滥。
 *
 * 匹配是分级的：
 *   1. 精确子串匹配（最快，也最可信）
 *   2. 宽松正则匹配：忽略空白差异、全半角标点差异、引号/破折号变体
 *   3. 指纹包含：只比较实义字符（用于模型改动了少量标点的情形）
 *   4. 都不通过 → 丢弃
 */
import { CATEGORY_BY_ID, SEVERITIES } from './taxonomy.js'
import { fingerprint } from '../normalize.js'

const SEVERITY_ALIASES = new Map(
  Object.entries({
    严重: 'critical',
    极高: 'critical',
    致命: 'critical',
    高危: 'high',
    高: 'high',
    较高: 'high',
    中: 'medium',
    中等: 'medium',
    一般: 'medium',
    低: 'low',
    较低: 'low',
    轻微: 'low',
    信息: 'info',
    提示: 'info',
    注意: 'info',
    无: 'info',
  }),
)

export function normalizeSeverity(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (SEVERITIES.includes(s)) return s
  if (SEVERITY_ALIASES.has(String(v ?? '').trim())) return SEVERITY_ALIASES.get(String(v ?? '').trim())
  if (s.startsWith('crit')) return 'critical'
  if (s.startsWith('high') || s.startsWith('sev')) return 'high'
  if (s.startsWith('med') || s.startsWith('mod')) return 'medium'
  if (s.startsWith('low') || s.startsWith('min')) return 'low'
  if (s.startsWith('info')) return 'info'
  return 'medium'
}

export function normalizeCategory(v) {
  const raw = String(v ?? '').trim()
  if (CATEGORY_BY_ID.has(raw)) return raw
  const snake = raw
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\w_]/g, '')
  if (CATEGORY_BY_ID.has(snake)) return snake
  // 中文标签 → id
  for (const [id, cat] of CATEGORY_BY_ID) {
    if (cat.label === raw) return id
  }
  return 'other'
}

const PUNCT_CLASS = {
  ',': '[,\\uFF0C]',
  '\uFF0C': '[,\\uFF0C]',
  '.': '[.\\u3002\\uFF0E]',
  '\u3002': '[.\\u3002\\uFF0E]',
  ';': '[;\\uFF1B]',
  '\uFF1B': '[;\\uFF1B]',
  ':': '[:\\uFF1A]',
  '\uFF1A': '[:\\uFF1A]',
  '(': '[(\\uFF08]',
  '\uFF08': '[(\\uFF08]',
  ')': '[)\\uFF09]',
  '\uFF09': '[)\\uFF09]',
  '"': '["\\u201C\\u201D]',
  '\u201C': '["\\u201C\\u201D]',
  '\u201D': '["\\u201C\\u201D]',
  "'": "['\\u2018\\u2019]",
  '\u2018': "['\\u2018\\u2019]",
  '\u2019': "['\\u2018\\u2019]",
  '-': '[\\-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015]',
  '\u2014': '[\\-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015]',
  '!': '[!\\uFF01]',
  '\uFF01': '[!\\uFF01]',
  '?': '[?\\uFF1F]',
  '\uFF1F': '[?\\uFF1F]',
  '/': '[/\\uFF0F]',
}

function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 由引文构造容错正则 */
export function buildFuzzyRegex(quote) {
  let pattern = ''
  const chars = Array.from(quote)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (/\s/.test(ch)) {
      // 空白折叠：连续空白 → \s*
      if (pattern.endsWith('\\s*')) continue
      pattern += '\\s*'
      continue
    }
    if (PUNCT_CLASS[ch]) {
      pattern += PUNCT_CLASS[ch]
      continue
    }
    pattern += escapeRe(ch)
  }
  // 收尾的 \s* 没有意义
  pattern = pattern.replace(/\\s\*$/, '')
  return new RegExp(pattern, 'i')
}

/**
 * 在给定文本中定位引文。
 * @returns {{start:number,end:number,matchType:'exact'|'fuzzy'|'fingerprint'}|null} 相对偏移
 */
export function locateQuote(quote, text) {
  const q = String(quote ?? '').trim()
  if (!q || !text) return null

  const exact = text.indexOf(q)
  if (exact !== -1) return { start: exact, end: exact + q.length, matchType: 'exact' }

  // 去空白后再精确匹配（模型常把换行写成空格）
  const collapsedQ = q.replace(/\s+/g, ' ')
  const collapsedText = text.replace(/\s+/g, ' ')
  if (collapsedQ !== q) {
    const idx = collapsedText.indexOf(collapsedQ)
    if (idx !== -1) {
      // 映射回原文本偏移：逐段推进
      const mapped = mapCollapsedIndex(text, idx, collapsedQ.length)
      if (mapped) return { ...mapped, matchType: 'exact' }
    }
  }

  if (q.length >= 6) {
    try {
      const re = buildFuzzyRegex(q)
      const m = re.exec(text)
      if (m) return { start: m.index, end: m.index + m[0].length, matchType: 'fuzzy' }
    } catch {
      /* 正则构造失败则跳过 */
    }
  }

  // 指纹级：只比较实义字符
  const fq = fingerprint(q)
  if (fq.length >= 6) {
    const ft = fingerprint(text)
    if (ft.includes(fq)) {
      // 能确认存在，但拿不到可靠偏移 → 交给调用方退化为整段高亮
      return null
    }
  }
  return null
}

/** 把「折叠空白后」的索引映射回原文索引 */
function mapCollapsedIndex(text, targetIdx, targetLen) {
  let collapsed = 0
  let start = -1
  let end = -1
  let i = 0
  let prevWasSpace = false
  for (; i < text.length; i++) {
    const ch = text[i]
    const isSpace = /\s/.test(ch)
    if (isSpace) {
      if (prevWasSpace) continue
      prevWasSpace = true
      if (collapsed === targetIdx && start === -1) start = i
      collapsed++
      if (collapsed === targetIdx + targetLen) {
        end = i
        break
      }
      continue
    }
    prevWasSpace = false
    if (collapsed === targetIdx && start === -1) start = i
    collapsed++
    if (collapsed === targetIdx + targetLen) {
      end = i + 1
      break
    }
  }
  if (start === -1) return null
  if (end === -1) end = text.length
  return { start, end }
}

function clean(v, max) {
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 核验并规范化模型给出的发现列表。
 *
 * @param {any[]} rawFindings
 * @param {Map<string,{id:string,text:string,start:number,heading:string}>} clauseById
 * @param {{ docText?:string, docOffsetBase?:number }} [ctx]
 * @returns {{ findings:any[], stats:{ input:number, kept:number, dropped:number, droppedNoQuote:number, fuzzy:number, crossClause:number } }}
 */
export function verifyFindings(rawFindings, clauseById, ctx = {}) {
  const findings = []
  const seen = new Set()
  const perClause = new Map()
  const stats = { input: 0, kept: 0, dropped: 0, droppedNoQuote: 0, fuzzy: 0, crossClause: 0 }

  for (const raw of Array.isArray(rawFindings) ? rawFindings : []) {
    stats.input++
    if (!raw || typeof raw !== 'object') {
      stats.dropped++
      continue
    }

    let clauseId = clean(raw.clauseId ?? raw.clause_id ?? raw.id, 40)
    let clause = clauseById.get(clauseId)
    const quote = clean(raw.quote ?? raw.text ?? raw.evidence, 400)
    if (!quote) {
      stats.droppedNoQuote++
      stats.dropped++
      continue
    }

    // 条款 id 不可信时，用引文反查归属条款
    if (!clause && ctx.docText) {
      const located = locateQuote(quote, ctx.docText)
      if (located) {
        const abs = located.start
        for (const c of clauseById.values()) {
          if (abs >= c.start && abs < c.end) {
            clause = c
            clauseId = c.id
            break
          }
        }
      }
    }
    if (!clause) {
      stats.dropped++
      continue
    }

    const rel = locateQuote(quote, clause.text)
    let absStart
    let absEnd
    let matchType = 'none'
    let crossClause = false

    if (rel) {
      absStart = clause.start + rel.start
      absEnd = clause.start + rel.end
      matchType = rel.matchType
    } else {
      // 条款内找不到 → 可能模型跨条款拼合，退一步在全文找
      if (ctx.docText) {
        const docLocated = locateQuote(quote, ctx.docText)
        if (docLocated) {
          absStart = docLocated.start
          absEnd = docLocated.end
          matchType = 'cross-clause'
          crossClause = true
          stats.crossClause++
        }
      }
      if (absStart === undefined) {
        // 指纹级核验通过但拿不到偏移：退化为整段高亮
        const fq = fingerprint(quote)
        if (fq.length >= 8 && fingerprint(clause.text).includes(fq)) {
          absStart = clause.start
          absEnd = clause.end
          matchType = 'clause'
        } else {
          stats.dropped++
          continue
        }
      }
    }

    if (matchType === 'fuzzy') stats.fuzzy++

    const category = normalizeCategory(raw.category ?? raw.type)
    const severity = normalizeSeverity(raw.severity ?? raw.level ?? raw.risk)

    // 引文以「原文切片」为准。
    // 模型输出的引文常与原文存在空白/标点差异（例如把换行写成空格），
    // 既然已经定位到了真实区间，就用原文切片作为展示引文，
    // 保证「看到的引文」与「高亮的区间」永远一致。
    let displayQuote = quote
    if (matchType !== 'clause' && ctx.docText && absEnd - absStart <= 400) {
      const sourceSlice = ctx.docText.slice(absStart, absEnd).trim()
      if (sourceSlice) displayQuote = sourceSlice
    }

    const title = clean(raw.title ?? raw.name, 40) || clean(displayQuote, 20)
    const explanation = clean(raw.explanation ?? raw.explain ?? raw.reason, 400)
    const impact = clean(raw.impact ?? raw.effect, 300)
    const advice = clean(raw.advice ?? raw.suggestion, 200)

    // hidden：模型标记的「一眼看不出来」的风险
    const hidden = raw.hidden === true || raw.hidden === 'true' || raw.isHidden === true

    // wording：具体可疑字眼。必须真的出现在原文里，否则丢弃 ——
    // 否则模型很容易随手编几个「看起来像法条」的词组，反而误导用户。
    const rawWording = Array.isArray(raw.wording) ? raw.wording : Array.isArray(raw.keywords) ? raw.keywords : []
    const clauseFingerprint = fingerprint(clause.text)
    const wording = []
    for (const w of rawWording) {
      const term = clean(w, 30)
      if (!term) continue
      if (clauseFingerprint.includes(fingerprint(term))) wording.push(term)
      if (wording.length >= 6) break
    }

    const key = `${clauseId}|${category}|${fingerprint(quote).slice(0, 80)}`
    if (seen.has(key)) {
      stats.dropped++
      continue
    }
    seen.add(key)

    const count = perClause.get(clauseId) ?? 0
    if (count >= 5) {
      stats.dropped++
      continue
    }
    perClause.set(clauseId, count + 1)

    findings.push({
      id: `f${findings.length + 1}`,
      clauseId,
      clauseHeading: clause.heading,
      category,
      severity,
      quote: displayQuote.slice(0, 300),
      modelQuote: displayQuote === quote ? undefined : quote.slice(0, 300),
      title,
      explanation,
      impact,
      advice,
      hidden,
      wording,
      start: absStart,
      end: absEnd,
      matchType,
      crossClause,
      verified: true,
    })
    stats.kept++
  }

  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.start - b.start)
  findings.forEach((f, i) => {
    f.id = `f${i + 1}`
  })

  return { findings, stats }
}


// ============================================================
// 条款解读（clauseNotes）
// ============================================================

const TONE_ALIASES = new Map(
  Object.entries({
    有利: 'favorable',
    对用户有利: 'favorable',
    中性: 'neutral',
    中立: 'neutral',
    不利: 'unfavorable',
    对用户不利: 'unfavorable',
    喜忧参半: 'mixed',
    混合: 'mixed',
  }),
)

export function normalizeTone(v) {
  const raw = String(v ?? '').trim()
  const lower = raw.toLowerCase()
  if (['favorable', 'neutral', 'unfavorable', 'mixed'].includes(lower)) return lower
  if (TONE_ALIASES.has(raw)) return TONE_ALIASES.get(raw)
  return 'neutral'
}

/**
 * 核验并规范化条款解读。
 * 条款 id 必须真实存在，否则丢弃 —— 解读挂在错误条款上比没有解读更糟。
 *
 * @param {any[]} rawNotes
 * @param {Map<string,{id:string,heading:string}>} clauseById
 * @returns {{ notes: any[], stats: { input:number, kept:number, dropped:number } }}
 */
export function verifyClauseNotes(rawNotes, clauseById) {
  const notes = []
  const seen = new Set()
  const stats = { input: 0, kept: 0, dropped: 0 }

  for (const raw of Array.isArray(rawNotes) ? rawNotes : []) {
    stats.input++
    if (!raw || typeof raw !== 'object') {
      stats.dropped++
      continue
    }
    const clauseId = clean(raw.clauseId ?? raw.clause_id ?? raw.id, 40)
    const clause = clauseById.get(clauseId)
    if (!clause) {
      stats.dropped++
      continue
    }
    if (seen.has(clauseId)) {
      stats.dropped++
      continue
    }

    const plain = clean(raw.plain ?? raw.summary ?? raw.title, 60)
    const meaning = clean(raw.meaning ?? raw.detail ?? raw.explanation, 400)
    if (!plain && !meaning) {
      stats.dropped++
      continue
    }

    const keyPoints = (Array.isArray(raw.keyPoints) ? raw.keyPoints : Array.isArray(raw.points) ? raw.points : [])
      .map((x) => clean(x, 60))
      .filter(Boolean)
      .slice(0, 4)

    seen.add(clauseId)
    notes.push({
      id: `n${notes.length + 1}`,
      clauseId,
      clauseHeading: clause.heading,
      plain: plain || meaning.slice(0, 30),
      meaning,
      keyPoints,
      tone: normalizeTone(raw.tone),
    })
    stats.kept++
  }

  // 按原文顺序排列，读起来才像一份说明书
  const order = new Map([...clauseById.keys()].map((id, i) => [id, i]))
  notes.sort((a, b) => (order.get(a.clauseId) ?? 0) - (order.get(b.clauseId) ?? 0))
  notes.forEach((n, i) => {
    n.id = `n${i + 1}`
  })

  return { notes, stats }
}

// ============================================================
// 跨条款联系（interactions）
// ============================================================

/**
 * 核验跨条款联系。
 * clauseIds 必须真实存在且至少两个 —— 组合效应的全部价值就在于「跨条款」，
 * 少于两条的条目没有意义。
 *
 * @param {any[]} rawInteractions
 * @param {Set<string>} validClauseIds
 * @returns {any[]}
 */
export function normalizeInteractions(rawInteractions, validClauseIds) {
  const out = []
  const seen = new Set()

  for (const raw of Array.isArray(rawInteractions) ? rawInteractions : []) {
    if (!raw || typeof raw !== 'object') continue

    const ids = (Array.isArray(raw.clauseIds) ? raw.clauseIds : Array.isArray(raw.clauses) ? raw.clauses : [])
      .map((x) => clean(x, 40))
      .filter((id) => validClauseIds.has(id))

    const unique = [...new Set(ids)]
    if (unique.length < 2) continue

    const title = clean(raw.title, 40)
    const explanation = clean(raw.explanation ?? raw.why ?? raw.detail, 300)
    const scenario = clean(raw.scenario ?? raw.example, 200)
    if (!title && !explanation) continue

    const key = unique.join('+')
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      id: `x${out.length + 1}`,
      clauseIds: unique,
      severity: normalizeSeverity(raw.severity),
      title: title || '条款组合效应',
      explanation,
      scenario,
    })
    if (out.length >= 5) break
  }

  out.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
  out.forEach((x, i) => {
    x.id = `x${i + 1}`
  })
  return out
}
