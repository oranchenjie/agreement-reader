/**
 * src/analyze/websearch.js
 *
 * 零依赖联网搜索模块（Node 内置 fetch + 手写 HTML 扫描器，不使用任何 DOM 库）。
 *
 * 设计立场：这个模块服务于一个"必须有抗逆性"的产品——联网搜索只是加分项，
 * 它失败绝不能让整个问答流程崩掉。因此对外契约只有一个：
 *
 *   webSearch() 永远不抛异常，永远返回结构化结果。
 *   网络不通 / 被限流 / 页面结构变了 / 解析不出结果 → { ok: false, results: [], warnings: [...] }
 *
 * 主来源：DuckDuckGo HTML 版（html.duckduckgo.com，POST 表单，需要浏览器 UA）。
 * 备用来源：Bing HTML 版（www.bing.com/search，结果块 li.b_algo）。
 * 两条链都失败时 provider = 'none'。
 *
 * 解析策略：容错优先，不依赖单一精确结构——
 *   1. 按"结果块容器"切段（DDG: div.result / div.web-result；Bing: li.b_algo），再在段内找标题/摘要；
 *   2. 切不出块时退回"锚点扫描"（直接找 a.result__a，并向后取窗口内的摘要）；
 *   3. 任何一步失败都只是"少几条结果"，不会抛错。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认超时（毫秒）。覆盖 fetch 与响应体读取的全过程。 */
const DEFAULT_TIMEOUT_MS = 12_000

/** 默认返回条数 */
const DEFAULT_MAX_RESULTS = 6

/** 单次请求最多读取的响应体字节数（超出即截断并记警告） */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 搜索词长度上限（超出截断） */
const MAX_QUERY_CHARS = 500

/** formatSearchResults 默认输出上限（字符） */
const DEFAULT_FORMAT_CHARS = 4000

/** 浏览器 UA：DuckDuckGo / Bing 的 HTML 版对非浏览器 UA 容易直接拒绝 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const COMMON_HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
}

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'
const BING_ENDPOINT = 'https://www.bing.com/search'

/** HTML 命名实体表（覆盖常见排版/标点/货币/数学实体） */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  bdquo: '„',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  minus: '−',
  le: '≤',
  ge: '≥',
  ne: '≠',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  prime: '′',
  Prime: '″',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  pi: 'π',
  sigma: 'σ',
  omega: 'ω',
}

/** 去重时忽略的跟踪参数（只用于生成去重键，不改变对外输出的 URL） */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  'ref_url',
  'spm',
  'scm',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'pk_campaign',
  'pk_kwd',
  'mtm_campaign',
  'mtm_source',
])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isAbortLike(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR')
}

function errorMessage(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  return String(err.message || err.name || err)
}

/** 生成带名字的错误（保持 Node 的 DOMException 语义） */
function abortError(name, message) {
  const err = new Error(message)
  err.name = name
  return err
}

function isHttpUrl(url) {
  return Boolean(url) && (url.protocol === 'http:' || url.protocol === 'https:')
}

function safeParseUrl(value, base) {
  try {
    return new URL(String(value), base)
  } catch {
    return null
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return fallback
  return Math.min(i, max)
}

function classTokens(value) {
  if (!value) return []
  return String(value).trim().split(/\s+/).filter(Boolean)
}

function hasClassToken(attrs, token) {
  return classTokens(attrs && attrs.class).includes(token)
}

/** 解析开始标签上的属性（支持双引号 / 单引号 / 无引号） */
function parseAttrs(rawTag) {
  const attrs = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g
  let m
  while ((m = re.exec(rawTag))) {
    const name = m[1].toLowerCase()
    if (Object.prototype.hasOwnProperty.call(attrs, name)) continue
    attrs[name] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : ''
  }
  return attrs
}

// ---------------------------------------------------------------------------
// HTML 实体解码 / 纯文本清洗
// ---------------------------------------------------------------------------

/**
 * 解码 HTML 实体：命名实体 + 十进制 &#39; + 十六进制 &#x4E2D;（分号可省略）。
 * 未知实体原样保留。
 */
function decodeEntities(input) {
  if (!input) return ''
  return String(input).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      if (!digits) return whole
      const code = Number.parseInt(digits, isHex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      // 代理区码点不能直接 fromCodePoint
      if (code >= 0xd800 && code <= 0xdfff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body]
    const lower = body.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower]
    return whole
  })
}

/**
 * HTML 片段 → 纯文本：去注释/脚本样式、块级标签转空格、剥离标签、解码实体、压缩空白。
 *
 * 注意顺序：先剥标签再解码实体。否则 `&lt;script&gt;` 解码出的 `<script>` 会被当成标签吃掉。
 */
function htmlToText(html) {
  if (!html) return ''
  let s = String(html)
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  s = s.replace(/<br\b[^>]*\/?>/gi, ' ')
  s = s.replace(
    /<\/(p|div|li|ul|ol|tr|td|th|table|thead|tbody|h[1-6]|section|article|header|footer|blockquote|pre|dd|dt|dl|figcaption|figure|main|aside|nav|form)\s*>/gi,
    ' ',
  )
  s = s.replace(/<[^>]*>/g, '')
  s = decodeEntities(s)
  return s.replace(/\s+/g, ' ').trim()
}

/** 已经是纯文本的输入：只压缩空白（不再剥标签，避免吃掉正文里的 `<...>`） */
function plainText(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

/** 把落单的代理项（半个 emoji）替换成 U+FFFD，避免 encodeURIComponent 抛 URIError */
function wellFormed(value) {
  const s = String(value)
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s
}

// ---------------------------------------------------------------------------
// 手写 HTML 扫描器（找元素 / 切结果块）
// ---------------------------------------------------------------------------

/** 从 from 位置开始，找同名标签的配对闭合标签位置（处理嵌套）；找不到返回字符串末尾 */
function findCloseIndex(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  re.lastIndex = from
  let depth = 1
  let m
  while ((m = re.exec(html))) {
    if (m[1] === '/') {
      depth -= 1
      if (depth === 0) return m.index
    } else if (!/\/>\s*$/.test(m[0])) {
      depth += 1
    }
  }
  return html.length
}

/**
 * 找第一个满足条件的元素。
 * @returns {{attrs:object, tag:string, html:string, start:number, end:number}|null}
 */
function findElement(html, tagNames, predicate, fromIndex = 0) {
  if (!html) return null
  const tags = Array.isArray(tagNames) ? tagNames : [tagNames]
  const re = new RegExp(`<(${tags.join('|')})\\b[^>]*>`, 'gi')
  re.lastIndex = fromIndex
  let m
  while ((m = re.exec(html))) {
    if (/\/>\s*$/.test(m[0])) continue
    const attrs = parseAttrs(m[0])
    const tag = m[1].toLowerCase()
    if (!predicate(attrs, tag, m[0])) continue
    const closeIdx = findCloseIndex(html, tag, re.lastIndex)
    return { attrs, tag, html: html.slice(re.lastIndex, closeIdx), start: m.index, end: closeIdx + tag.length + 3 }
  }
  return null
}

/** 找全部满足条件的元素（用于兜底扫描） */
function findAllElements(html, tagNames, predicate) {
  const out = []
  if (!html) return out
  let from = 0
  for (;;) {
    const el = findElement(html, tagNames, predicate, from)
    if (!el) break
    out.push(el)
    from = el.end > from ? el.end : from + 1
    if (out.length >= 200) break
  }
  return out
}

/**
 * 按"结果块容器"把整页切段：每段从容器开始标签之后，到下一个同类容器开始标签之前。
 * @returns {Array<{attrs:object, html:string, start:number, end:number}>}
 */
function collectBlocks(html, tagNames, predicate) {
  if (!html) return []
  const tags = Array.isArray(tagNames) ? tagNames : [tagNames]
  const re = new RegExp(`<(${tags.join('|')})\\b[^>]*>`, 'gi')
  const found = []
  let m
  while ((m = re.exec(html))) {
    if (/\/>\s*$/.test(m[0])) continue
    const attrs = parseAttrs(m[0])
    if (!predicate(attrs, m[1].toLowerCase())) continue
    found.push({ start: m.index, openEnd: re.lastIndex, attrs })
    if (found.length >= 200) break
  }
  return found.map((f, i) => {
    const end = i + 1 < found.length ? found[i + 1].start : html.length
    return { attrs: f.attrs, start: f.start, end, html: html.slice(f.openEnd, end) }
  })
}

// ---------------------------------------------------------------------------
// URL 清洗 / 跳转链接还原 / 去重
// ---------------------------------------------------------------------------

/** 解码 Bing 的 /ck/a?...&u=a1<base64url> 跳转参数 */
function decodeBingRedirectToken(token) {
  if (!token) return ''
  let s = String(token)
  if (s.startsWith('a1')) s = s.slice(2)
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4 !== 0) s += '='
  try {
    const decoded = decodeBase64ToString(s)
    return /^https?:\/\//i.test(decoded) ? decoded : ''
  } catch {
    return ''
  }
}

/**
 * 把 href 还原成"真实可访问的 http(s) URL"。
 * 返回 '' 表示这条结果应当被丢弃（伪协议 / 站内导航 / 搜索引擎跳转壳）。
 */
function resolveResultUrl(rawHref, base) {
  let href = decodeEntities(rawHref || '').trim()
  if (!href) return ''
  // 去掉零宽字符与包裹引号
  href = href.replace(/[\u200b-\u200f\ufeff]/g, '').replace(/^["'<]+|["'>]+$/g, '')
  // 伪协议：直接丢弃
  if (/^(?:javascript|data|vbscript|file|blob|about|chrome|chrome-extension|mailto|tel|sms|ftp)\s*:/i.test(href)) {
    return ''
  }
  const url = safeParseUrl(href, base)
  if (!url || !isHttpUrl(url)) return ''
  if (!url.hostname) return ''

  const host = url.hostname.toLowerCase()

  // DuckDuckGo：真实地址在 /l/?uddg=<urlencoded>；站内其它链接一律丢弃
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
    if (!url.pathname.startsWith('/l/')) return ''
    const target = url.searchParams.get('uddg') || url.searchParams.get('u')
    if (!target) return ''
    const real = safeParseUrl(target)
    return real && isHttpUrl(real) && real.hostname ? real.toString() : ''
  }

  // Bing：真实地址在 /ck/a?...&u=a1<base64url>；站内链接丢弃
  if (host === 'bing.com' || host.endsWith('.bing.com')) {
    if (!url.pathname.startsWith('/ck/a')) return ''
    const real = safeParseUrl(decodeBingRedirectToken(url.searchParams.get('u')))
    return real && isHttpUrl(real) && real.hostname ? real.toString() : ''
  }

  return url.toString()
}

/** 去重键：忽略 hash、末尾斜杠与常见跟踪参数 */
function dedupeKey(url) {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '')
    let qs = ''
    if (u.search) {
      const params = new URLSearchParams(u.search)
      for (const key of [...params.keys()]) {
        if (TRACKING_PARAMS.has(key.toLowerCase())) params.delete(key)
      }
      qs = params.toString()
    }
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? ':' + u.port : ''}${path}${qs ? '?' + qs : ''}`
  } catch {
    return String(url)
  }
}

// ---------------------------------------------------------------------------
// 结果归一化
// ---------------------------------------------------------------------------

/**
 * 把原始命中（href + 原始 HTML 标题/摘要）归一化成对外结果。
 * @param {Array<{href:string, title:string, snippet:string, base:string}>} hits
 */
function normalizeHits(hits, { maxResults, warnings }) {
  const out = []
  const seen = new Set()
  let duplicates = 0
  let invalid = 0
  let emptyTitle = 0

  for (const hit of hits) {
    const url = resolveResultUrl(hit.href, hit.base)
    if (!url) {
      invalid += 1
      continue
    }
    const title = htmlToText(hit.title)
    if (!title) {
      emptyTitle += 1
      continue
    }
    const key = dedupeKey(url)
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    out.push({ title, url, snippet: htmlToText(hit.snippet) })
  }

  if (duplicates) warnings.push(`已按 URL 去重，忽略 ${duplicates} 条重复结果`)
  if (invalid) warnings.push(`已忽略 ${invalid} 条无效链接（伪协议或非 http/https 地址）`)
  if (emptyTitle) warnings.push(`已忽略 ${emptyTitle} 条无标题结果`)

  return out.slice(0, maxResults)
}

// ---------------------------------------------------------------------------
// 各来源解析器
// ---------------------------------------------------------------------------

/** DuckDuckGo HTML 版解析：优先按结果块切段，失败则退回锚点扫描 */
function parseDuckDuckGo(html, { warnings }) {
  const hits = []
  const isSnippetEl = (attrs) => hasClassToken(attrs, 'result__snippet') || hasClassToken(attrs, 'result-snippet')

  const blocks = collectBlocks(html, ['div'], (attrs) => {
    const tokens = classTokens(attrs.class)
    if (!(tokens.includes('result') || tokens.includes('web-result'))) return false
    // 广告位（class 里带 result--ad）不是自然结果
    if (tokens.some((t) => t.startsWith('result--ad'))) return false
    return true
  })

  for (const block of blocks) {
    const titleEl = findElement(block.html, 'a', (attrs) => hasClassToken(attrs, 'result__a') || hasClassToken(attrs, 'result-link'))
    if (!titleEl || !titleEl.attrs.href) continue
    const snippetEl =
      findElement(block.html, ['a', 'div', 'td', 'span'], isSnippetEl) || findElement(block.html, ['div', 'td'], (attrs) => hasClassToken(attrs, 'result__snippet'))
    hits.push({
      href: titleEl.attrs.href,
      title: titleEl.html,
      snippet: snippetEl ? snippetEl.html : '',
      base: DDG_ENDPOINT,
    })
  }

  // 兜底：页面结构变了 / 块容器换了 class，就直接扫 result__a，并向后取窗口找摘要
  if (!hits.length) {
    const anchors = findAllElements(html, 'a', (attrs) => hasClassToken(attrs, 'result__a') || hasClassToken(attrs, 'result-link'))
    for (const anchor of anchors) {
      if (!anchor.attrs.href) continue
      const window = html.slice(anchor.end, anchor.end + 4000)
      const snippetEl = findElement(window, ['a', 'div', 'td', 'span'], isSnippetEl)
      hits.push({
        href: anchor.attrs.href,
        title: anchor.html,
        snippet: snippetEl ? snippetEl.html : '',
        base: DDG_ENDPOINT,
      })
    }
    if (hits.length) warnings.push('DuckDuckGo 页面结构可能与预期不同，已使用兜底解析')
  }

  return hits
}

/** Bing HTML 版解析：结果块 li.b_algo / div.b_algo */
function parseBing(html, { warnings }) {
  const hits = []
  const isSnippetEl = (attrs) =>
    hasClassToken(attrs, 'b_lineclamp') ||
    hasClassToken(attrs, 'b_snippet') ||
    hasClassToken(attrs, 'b_algoSlug') ||
    hasClassToken(attrs, 'b_paractl')

  const blocks = collectBlocks(html, ['li', 'div'], (attrs) => hasClassToken(attrs, 'b_algo'))

  for (const block of blocks) {
    const heading = findElement(block.html, 'h2', () => true)
    const scope = heading ? heading.html : block.html
    let titleEl = findElement(scope, 'a', (attrs) => Boolean(attrs.href))
    if (!titleEl) titleEl = findElement(block.html, 'a', (attrs) => hasClassToken(attrs, 'tilk') || Boolean(attrs.href))
    if (!titleEl || !titleEl.attrs.href) continue

    const snippetEl =
      findElement(block.html, 'p', () => true) ||
      findElement(block.html, ['div', 'span'], isSnippetEl) ||
      findElement(block.html, 'div', (attrs) => hasClassToken(attrs, 'b_caption'))
    hits.push({
      href: titleEl.attrs.href,
      title: titleEl.html,
      snippet: snippetEl ? snippetEl.html : '',
      base: BING_ENDPOINT,
    })
  }

  // 兜底：直接扫 h2 > a
  if (!hits.length) {
    const headings = findAllElements(html, 'h2', () => true)
    for (const heading of headings) {
      const anchor = findElement(heading.html, 'a', (attrs) => Boolean(attrs.href))
      if (!anchor) continue
      const tail = html.slice(heading.end, heading.end + 3000)
      const snippetEl = findElement(tail, 'p', () => true)
      hits.push({
        href: anchor.attrs.href,
        title: anchor.html,
        snippet: snippetEl ? snippetEl.html : '',
        base: BING_ENDPOINT,
      })
    }
    if (hits.length) warnings.push('Bing 页面结构可能与预期不同，已使用兜底解析')
  }

  return hits
}

/** 页面是否像"反爬/异常流量"拦截页 */
function looksBlocked(text) {
  if (!text) return false
  const head = text.slice(0, 20000)
  return /anomaly-modal|unusual traffic|detected unusual|are you a robot|enable javascript and cookies|cf-browser-verification|captcha/i.test(
    head,
  )
}

// ---------------------------------------------------------------------------
// 网络请求（超时 / 大小上限 / 编码）
// ---------------------------------------------------------------------------

function resolveTextDecoder(contentType) {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType || '')
  const label = (m && m[1] ? m[1] : 'utf-8').toLowerCase()
  try {
    return new TextDecoder(label)
  } catch {
    try {
      return new TextDecoder('utf-8')
    } catch {
      return null
    }
  }
}

function decodeChunk(decoder, chunk, stream) {
  try {
    if (!decoder) return decodeBytesToString(chunk)
    return chunk === null ? decoder.decode() : decoder.decode(chunk, { stream })
  } catch {
    return ''
  }
}

/**
 * 读取响应体，最多 capBytes 字节；超出即截断。
 * @returns {Promise<{text:string, truncated:boolean, bytes:number, contentType:string}>}
 */
async function readCappedBody(res, capBytes, signal) {
  const contentType = typeof res?.headers?.get === 'function' ? res.headers.get('content-type') || '' : ''
  const decoder = resolveTextDecoder(contentType)

  const body = res?.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    let bytes = 0
    let truncated = false
    let text = ''
    try {
      for (;;) {
        if (signal && signal.aborted) throw abortError('AbortError', '已取消')
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const size = value.byteLength || 0
        bytes += size
        if (bytes > capBytes) {
          const keep = Math.max(0, size - (bytes - capBytes))
          if (keep > 0) text += decodeChunk(decoder, value.subarray ? value.subarray(0, keep) : value, true)
          truncated = true
          break
        }
        text += decodeChunk(decoder, value, true)
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* 忽略取消异常 */
      }
    }
    // 截断时不做 flush：避免补出半个多字节字符的替换符
    if (!truncated) text += decodeChunk(decoder, null, false)
    return { text, truncated, bytes, contentType }
  }

  // 兜底：注入的假响应只实现了 text()
  if (typeof res?.text === 'function') {
    const raw = String(await res.text())
    if (raw.length > capBytes) {
      return { text: raw.slice(0, capBytes), truncated: true, bytes: raw.length, contentType }
    }
    return { text: raw, truncated: false, bytes: raw.length, contentType }
  }

  throw new Error('响应对象不可读（既无 body 也无 text()）')
}

/**
 * 发起一次请求：超时覆盖 fetch + 读取全过程；mock 不理会 signal 时也能超时返回。
 * @returns {Promise<{status:number, ok:boolean, text:string, truncated:boolean, bytes:number}>}
 */
async function requestHtml({ url, init, fetchImpl, timeoutMs, signal }) {
  const ctrl = new AbortController()
  const signals = [ctrl.signal]
  if (signal) signals.push(signal)
  const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : ctrl.signal

  // 自带的定时器：即使注入的 fetchImpl 完全不理 signal，也能按超时返回
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        ctrl.abort()
      } catch {
        /* 忽略 */
      }
      reject(abortError('TimeoutError', `请求超时（${timeoutMs}ms）`))
    }, timeoutMs)
  })

  const work = (async () => {
    const res = await fetchImpl(url, { ...init, signal: combined })
    const status = Number(res?.status) || 0
    const ok = res && res.ok !== undefined ? Boolean(res.ok) : status >= 200 && status < 300
    const body = await readCappedBody(res, MAX_BODY_BYTES, combined)
    return { status, ok, ...body }
  })()
  // 超时后 work 可能仍悬挂/稍后 reject，这里挂一个吞掉的 catch，避免 unhandledRejection
  work.catch(() => {})

  try {
    return await Promise.race([work, timeoutPromise])
  } finally {
    // 必须清掉定时器，否则一个 12s 的挂起 timer 会拖住整个进程退出
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

function emptyResult(query, warnings, provider = 'none') {
  return { ok: false, query, results: [], provider, warnings }
}

/**
 * 联网搜索。
 *
 * 契约：永不抛异常。失败时返回 { ok:false, results:[], provider:'none', warnings:[中文原因] }。
 *
 * @param {string} query
 * @param {{ maxResults?: number, timeoutMs?: number, signal?: AbortSignal, fetchImpl?: Function }} [opts]
 * @returns {Promise<{ ok: boolean, query: string, results: Array<{title:string,url:string,snippet:string}>, provider: string, warnings: string[] }>}
 */

/**
 * 把 base64 / base64url 字符串解码成 UTF-8 文本（同构）。
 * 不用 Buffer —— 那是 Node 专有全局，浏览器里没有。
 */
function decodeBase64ToString(input) {
  let s = String(input ?? '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  while (s.length % 4 !== 0) s += '='
  try {
    const bin = typeof atob === 'function' ? atob(s) : globalThis.Buffer.from(s, 'base64').toString('latin1')
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return ''
  }
}

/** 把字节块解码成 UTF-8 文本（同构） */
function decodeBytesToString(chunk) {
  if (!chunk) return ''
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  return new TextDecoder('utf-8').decode(bytes)
}

export async function webSearch(query, opts = {}) {
  const warnings = []

  try {
    const options = opts && typeof opts === 'object' ? opts : {}
    const signal = options.signal && typeof options.signal.addEventListener === 'function' ? options.signal : null
    const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch

    // ---- 参数校验：非字符串 / 空串一律直接失败，不发请求 ----
    if (typeof query !== 'string') {
      return emptyResult('', ['搜索词必须是字符串，已跳过联网搜索'], 'none')
    }
    let q = wellFormed(query).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!q) {
      return emptyResult('', ['搜索词为空，无法发起联网搜索'], 'none')
    }
    // 按码点截断，避免把 emoji 的代理对切成半个字符
    const codePoints = Array.from(q)
    if (codePoints.length > MAX_QUERY_CHARS) {
      q = codePoints.slice(0, MAX_QUERY_CHARS).join('')
      warnings.push(`搜索词过长，已截断至 ${MAX_QUERY_CHARS} 个字符`)
    }

    if (typeof fetchImpl !== 'function') {
      return emptyResult(q, ['当前运行环境不支持 fetch，无法联网搜索'], 'none')
    }
    if (signal && signal.aborted) {
      return emptyResult(q, ['联网搜索已被取消'], 'none')
    }

    const maxResults = clampInt(options.maxResults, DEFAULT_MAX_RESULTS, 1, 20)
    const timeoutMs = clampInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000)

    const providers = [
      {
        name: 'duckduckgo',
        label: 'DuckDuckGo',
        build: () => ({
          url: DDG_ENDPOINT,
          init: {
            method: 'POST',
            headers: { ...COMMON_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(),
            redirect: 'follow',
          },
        }),
        parse: parseDuckDuckGo,
      },
      {
        name: 'bing',
        label: 'Bing',
        build: () => ({
          url: `${BING_ENDPOINT}?q=${encodeURIComponent(wellFormed(q))}&count=${maxResults}&setlang=zh-CN`,
          init: { method: 'GET', headers: { ...COMMON_HEADERS }, redirect: 'follow' },
        }),
        parse: parseBing,
      },
    ]

    for (let i = 0; i < providers.length; i += 1) {
      const provider = providers[i]
      const failReason = await (async () => {
        try {
          const request = provider.build()
          const res = await requestHtml({
            url: request.url,
            init: request.init,
            fetchImpl,
            timeoutMs,
            signal,
          })

          if (res.truncated) {
            warnings.push(`响应体超过 2MB 上限，已截断（来源：${provider.label}）`)
          }
          if (signal && signal.aborted) return '联网搜索已被取消'
          if (!res.ok) return `${provider.label} 返回 HTTP ${Number(res.status) || '未知状态'}`
          if (looksBlocked(res.text)) return `${provider.label} 疑似触发反爬验证`
          if (!res.text) return `${provider.label} 返回了空响应`

          const hits = provider.parse(res.text, { warnings })
          const results = normalizeHits(hits, { maxResults, warnings })
          if (!results.length) return `${provider.label} 未解析到任何搜索结果（页面结构可能已变化）`

          return { results }
        } catch (err) {
          if (signal && signal.aborted) return '联网搜索已被取消'
          if (isAbortLike(err)) return `${provider.label} 请求超时（${timeoutMs}ms）`
          return `${provider.label} 请求失败：${errorMessage(err)}`
        }
      })()

      if (typeof failReason === 'string') {
        warnings.push(failReason)
        // 用户主动取消：立即结束整条降级链，不再尝试备用来源
        if (signal && signal.aborted) break
        const next = providers[i + 1]
        if (next) warnings.push(`${provider.label} 不可用，已切换到备用来源 ${next.label}`)
        continue
      }

      return {
        ok: true,
        query: q,
        results: failReason.results,
        provider: provider.name,
        warnings: [...new Set(warnings)],
      }
    }

    if (!warnings.length) warnings.push('所有搜索来源均不可用，且未获得失败原因')
    return emptyResult(q, [...new Set(warnings)], 'none')
  } catch (err) {
    // 最后一道防线：本函数对调用方承诺永不抛异常
    warnings.push(`联网搜索发生未预期错误：${errorMessage(err)}`)
    return emptyResult(typeof query === 'string' ? query : '', [...new Set(warnings)], 'none')
  }
}

/**
 * 把搜索结果整理成可放进提示词的纯文本。
 *
 * 输出形如：
 *   [1] 标题
 *       https://example.com/page
 *       摘要文字……
 *
 * @param {Array<{title:string,url:string,snippet:string}>} results
 * @param {{ maxChars?: number }} [opts]
 * @returns {string} 总长度不超过 maxChars（默认 4000 字符）；空输入返回 ''
 */
export function formatSearchResults(results, opts = {}) {
  try {
    if (!Array.isArray(results) || results.length === 0) return ''
    const options = opts && typeof opts === 'object' ? opts : {}
    const maxChars = clampInt(options.maxChars, DEFAULT_FORMAT_CHARS, 1, 1_000_000)

    const items = []
    for (const r of results) {
      if (!r || typeof r !== 'object') continue
      const title = plainText(r.title)
      const url = plainText(r.url)
      const snippet = plainText(r.snippet)
      if (!title && !url) continue
      items.push({ title: title || '(无标题)', url, snippet })
    }
    if (!items.length) return ''

    const blocks = items.map((it, i) => {
      const lines = [`[${i + 1}] ${it.title}`]
      if (it.url) lines.push(`    ${it.url}`)
      if (it.snippet) lines.push(`    ${it.snippet}`)
      return lines.join('\n')
    })
    const full = blocks.join('\n\n')
    if (full.length <= maxChars) return full

    const note = `\n\n…（内容已截断：共 ${items.length} 条结果，仅显示前 ${maxChars} 字符）`
    // 剩余额度太小，连提示都放不下时，直接硬截断
    if (maxChars <= note.length) return full.slice(0, maxChars)

    const budget = maxChars - note.length
    const head = full.slice(0, budget).replace(/\s+$/, '')
    const out = head + note
    return out.length <= maxChars ? out : out.slice(0, maxChars)
  } catch {
    return ''
  }
}
