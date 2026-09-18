/**
 * 统一提取层（Extraction Registry）。
 *
 * 这一层是「适应一切输入形式」的落点：不论用户粘贴纯文本、丢进 PDF/Word/HTML/JSON，
 * 还是给一个网址，最终都收敛成 { text, title, meta } 这一份规范结构，下游完全无感。
 *
 * 设计要点：
 *  - 按「魔数 → MIME → 扩展名」三级判定格式，不信任任何单一来源。
 *  - 各格式解析器按需动态加载，任何一个缺失/损坏都不影响其他格式（可插拔）。
 *  - 中文站点常见的 GBK/GB18030/Big5 编码做专门处理，否则会得到满屏乱码。
 *  - 每一步失败都降级并给出中文警告，绝不把异常直接抛给用户。
 */
import { config, redactSecrets } from '../config.js'
import { extractDocxText } from './docx.js'
/**
 * 无头浏览器渲染只在服务端可用（要 spawn 本机 Chrome）。
 * 用**动态 import + 环境判断**，否则静态导入 `./browser.js` 会让这个模块
 * 在纯静态站点里直接加载失败（browser.js 依赖 node:child_process）。
 */
const isNodeRuntime = typeof process !== 'undefined' && Boolean(process.versions?.node)

let browserMod = null
async function loadBrowserModule() {
  if (!isNodeRuntime) return null
  if (browserMod === null) {
    try {
      browserMod = await import('./browser.js')
    } catch {
      browserMod = false
    }
  }
  return browserMod || null
}

/** 支持的格式说明（用于 /api/formats 与前端提示） */
export const FORMATS = [
  { id: 'text', label: '纯文本 / Markdown', extensions: ['.txt', '.md', '.markdown', '.text', '.log'] },
  { id: 'html', label: '网页 / HTML', extensions: ['.html', '.htm', '.xhtml', '.mhtml', '.mht'] },
  { id: 'pdf', label: 'PDF 文档', extensions: ['.pdf'] },
  { id: 'docx', label: 'Word 文档（.docx）', extensions: ['.docx'] },
  { id: 'json', label: 'JSON', extensions: ['.json'] },
  { id: 'url', label: '网址抓取', extensions: [] },
]

const CHARSET_ALIASES = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  gb2312: 'gbk',
  'gb-2312': 'gbk',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  big5hkscs: 'big5',
  latin1: 'windows-1252',
  'iso-8859-1': 'windows-1252',
  ascii: 'utf-8',
  'us-ascii': 'utf-8',
  shift_jis: 'shift_jis',
  sjis: 'shift_jis',
  euc_jp: 'euc-jp',
  euckr: 'euc-kr',
  koi8r: 'koi8-r',
  windows1252: 'windows-1252',
}

function normalizeCharset(cs) {
  if (!cs) return null
  const key = String(cs).trim().toLowerCase().replace(/["']/g, '')
  return CHARSET_ALIASES[key] ?? key
}

/** 只解码头部的 charset 声明，避免整篇按错误编码解码 */
function sniffMetaCharset(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('latin1')
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)
  if (m) return m[1]
  m = /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i.exec(head)
  if (m) return m[1]
  return null
}

/**
 * 把 Buffer 解码成字符串，自动处理 BOM 与中文编码。
 * @param {Buffer} buffer
 * @param {string} [declaredCharset]
 */
export function decodeBuffer(buffer, declaredCharset) {
  // BOM 优先
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), charset: 'utf-8' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), charset: 'utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), charset: 'utf-16be' }
  }

  const candidates = []
  const declared = normalizeCharset(declaredCharset)
  if (declared) candidates.push(declared)
  const sniffed = normalizeCharset(sniffMetaCharset(buffer))
  if (sniffed && !candidates.includes(sniffed)) candidates.push(sniffed)
  candidates.push('utf-8')

  for (const cs of candidates) {
    try {
      const decoder = new TextDecoder(cs, { fatal: false })
      const text = decoder.decode(buffer)
      // UTF-8 快速合法性判断：出现大量替换字符说明这个编码不对
      if (cs === 'utf-8') {
        const bad = (text.match(/\uFFFD/g) || []).length
        if (bad > Math.max(4, text.length * 0.002)) continue
      }
      return { text, charset: cs }
    } catch {
      /* 不支持的编码，换下一个 */
    }
  }

  return { text: buffer.toString('utf8'), charset: 'utf-8' }
}

/**
 * 判定输入格式。
 * @param {Buffer} buffer
 * @param {{ filename?:string, mime?:string }} [hint]
 * @returns {'pdf'|'docx'|'html'|'json'|'text'|'zip'|'doc'}
 */
export function detectFormat(buffer, hint = {}) {
  const ext = (hint.filename ?? '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  const mime = (hint.mime ?? '').toLowerCase()

  // 1) 魔数
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF') return 'pdf'
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xd0cf11e0) return 'doc'
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    if (ext === '.docx' || mime.includes('wordprocessingml')) return 'docx'
    // 通过 ZIP 内部结构判断是否为 docx
    if (buffer.includes(Buffer.from('word/document.xml'))) return 'docx'
    return 'zip'
  }

  // 2) 扩展名
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.doc') return 'doc'
  if (['.html', '.htm', '.xhtml', '.mhtml', '.mht'].includes(ext)) return 'html'
  if (ext === '.json') return 'json'

  // 3) MIME
  if (mime.includes('pdf')) return 'pdf'
  if (mime.includes('html') || mime.includes('xhtml')) return 'html'
  if (mime.includes('json')) return 'json'
  if (mime.includes('wordprocessingml')) return 'docx'

  // 4) 内容特征
  const head = buffer.subarray(0, 2048).toString('latin1').trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /<body[\s>]/.test(head)) return 'html'
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(buffer.subarray(0, Math.min(buffer.length, 200_000)).toString('utf8'))
      return 'json'
    } catch {
      /* 不是 JSON */
    }
  }
  return 'text'
}

// ---- 可选解析器的动态加载（缺失时不影响其他格式） ----
const optionalLoaders = {
  pdf: () => import('./pdf.js'),
  html: () => import('./html.js'),
}

async function tryLoad(name) {
  try {
    const mod = await optionalLoaders[name]()
    return mod ?? null
  } catch {
    return null
  }
}

/** 内建兜底 HTML → 文本（当 html.js 不可用或异常时使用） */
function fallbackHtmlToText(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const decoded = stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
  return decoded
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function extractJsonText(text) {
  const chunks = []
  const walk = (v, depth = 0) => {
    if (depth > 8) return
    if (typeof v === 'string') {
      const s = v.trim()
      // 只收有实质内容的字符串，过滤掉 id/url/短标签
      if (s.length >= 40 && /[\s\u4e00-\u9fff]/.test(s)) chunks.push(s)
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1))
      return
    }
    if (v && typeof v === 'object') {
      Object.values(v).forEach((x) => walk(x, depth + 1))
    }
  }
  try {
    walk(JSON.parse(text))
  } catch {
    return { text, warning: null }
  }
  if (chunks.length === 0) {
    return { text: '', warning: 'JSON 中未找到足够长的文本字段。' }
  }
  return { text: chunks.join('\n\n'), warning: null }
}

/**
 * 从 Buffer 提取文本。
 *
 * @param {Buffer} buffer
 * @param {{ filename?:string, mime?:string, url?:string }} [hint]
 * @returns {Promise<{ text:string, title:string, meta:{ format:string, extractor:string, charset?:string, warnings:string[], details?:object } }>}
 */
export async function extractFromBuffer(buffer, hint = {}) {
  const warnings = []
  const format = detectFormat(buffer, hint)
  let text = ''
  let title = ''
  let extractor = format
  let details = null
  let charset

  switch (format) {
    case 'pdf': {
      const mod = await tryLoad('pdf')
      if (!mod?.extractPdfText) {
        warnings.push('PDF 解析模块不可用，无法提取该文件。')
        break
      }
      try {
        const res = await mod.extractPdfText(buffer)
        text = res.text ?? ''
        warnings.push(...(res.meta?.warnings ?? []))
        details = { pageCount: res.meta?.pageCount ?? 0 }
      } catch (err) {
        warnings.push(`PDF 解析失败：${err?.message ?? err}`)
      }
      break
    }

    case 'docx': {
      try {
        const res = extractDocxText(buffer)
        text = res.text
        title = res.title
        warnings.push(...(res.meta?.warnings ?? []))
        details = { parts: res.meta?.parts ?? [] }
      } catch (err) {
        warnings.push(`DOCX 解析失败：${err?.message ?? err}`)
      }
      break
    }

    case 'doc': {
      warnings.push('旧版 .doc 二进制格式不受支持，请另存为 .docx，或复制正文后直接粘贴。')
      break
    }

    case 'zip': {
      warnings.push('该压缩包不是 DOCX，无法解析。请解压后上传其中的文档。')
      break
    }

    case 'json': {
      const { text: raw } = decodeBuffer(buffer, hint.mime)
      const res = extractJsonText(raw)
      text = res.text
      if (res.warning) warnings.push(res.warning)
      extractor = 'json'
      break
    }

    case 'html': {
      const decoded = decodeBuffer(buffer)
      charset = decoded.charset
      const mod = await tryLoad('html')
      if (mod?.extractMainText) {
        try {
          const res = mod.extractMainText(decoded.text, { url: hint.url })
          text = res.text ?? ''
          title = res.title ?? ''
          warnings.push(...(res.meta?.warnings ?? []))
          details = { strategy: res.meta?.strategy, candidates: res.meta?.candidates?.slice(0, 5) }
        } catch (err) {
          warnings.push(`HTML 正文提取异常，已改用简单模式：${err?.message ?? err}`)
          text = fallbackHtmlToText(decoded.text)
          extractor = 'html-fallback'
        }
      } else {
        warnings.push('HTML 正文提取模块不可用，已使用简单模式（可能包含导航等噪声）。')
        text = fallbackHtmlToText(decoded.text)
        extractor = 'html-fallback'
      }
      break
    }

    default: {
      const decoded = decodeBuffer(buffer, hint.mime)
      text = decoded.text
      charset = decoded.charset
      extractor = 'text'
      // 有些用户会把 HTML 存成 .txt
      if (/<(html|body|div|p)\b/i.test(text.slice(0, 2000))) {
        const mod = await tryLoad('html')
        if (mod?.extractMainText) {
          try {
            const res = mod.extractMainText(text, { url: hint.url })
            if ((res.text ?? '').length > text.length * 0.3) {
              text = res.text
              title = res.title ?? ''
              extractor = 'html'
              details = { strategy: res.meta?.strategy }
            }
          } catch {
            /* 保持原样 */
          }
        }
      }
      break
    }
  }

  if (!text.trim() && format !== 'doc' && format !== 'zip') {
    warnings.push('未能从该文件中提取到文本内容。若是扫描件/图片型文档，请改用截图或直接粘贴文本。')
  }

  return {
    text: text.trim(),
    title: title.trim(),
    meta: { format, extractor, charset, warnings: [...new Set(warnings)], details },
  }
}

// ---------- URL 抓取 ----------

const PRIVATE_HOST_RE =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i

/**
 * 规整用户输入的网址。
 *
 * 实测最常见的抓取失败原因不是网络问题，而是用户直接粘了 `www.example.com/terms`
 * 这种不带协议头的地址。这里自动补全，并对中文全角冒号/斜杠做归一化（从中文文档里
 * 复制网址时很常见）。
 *
 * @param {string} raw
 * @returns {string} 可交给 new URL 的地址
 */
export function normalizeUrlInput(raw) {
  let s = String(raw ?? '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '') // 零宽字符
    .replace(/[\uFF1A]/g, ':') // 全角冒号
    .replace(/[\uFF0F]/g, '/') // 全角斜杠
    .replace(/\s+/g, '') // 网址内部不应有空白（粘贴时常带入）
    .trim()

  if (!s) {
    throw Object.assign(new Error('请输入网址。'), { status: 400 })
  }
  // 没有 scheme 就补 https://
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = s.replace(/^\/+/, '')
    s = `https://${s}`
  }
  return s
}

/** 防 SSRF：拒绝内网/本机地址（可通过 ALLOW_PRIVATE_URLS=1 放行） */
export function assertPublicUrl(rawUrl) {
  const normalized = normalizeUrlInput(rawUrl)
  let u
  try {
    u = new URL(normalized)
  } catch {
    throw Object.assign(new Error(`网址无法解析：${normalized}。请检查是否输入正确。`), { status: 400 })
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw Object.assign(new Error('只支持 http/https 网址。'), { status: 400 })
  }
  if (!config.allowPrivateUrls && PRIVATE_HOST_RE.test(u.hostname)) {
    throw Object.assign(new Error('出于安全考虑，默认禁止抓取内网或本机地址。'), { status: 400, code: 'PRIVATE_URL' })
  }
  return u
}

/** 把网络层异常翻译成用户能看懂、并且知道该怎么办的中文提示 */
function explainFetchError(err, url) {
  const code = err?.cause?.code ?? err?.code ?? ''
  const name = err?.name ?? ''

  if (name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || name === 'AbortError') {
    return '抓取超时。该站点可能响应很慢，或屏蔽了自动抓取。可以稍后重试，或直接复制正文粘贴。'
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败，请检查网址是否拼写正确、以及本机网络是否正常。'
    case 'ECONNREFUSED':
      return '对方拒绝了连接（端口未开放）。'
    case 'ECONNRESET':
      return '连接被对方重置，可能触发了该站点的反爬限制。'
    case 'ETIMEDOUT':
      return '连接超时，该站点可能无法从当前网络访问。'
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'HTTPS 证书校验失败，无法安全访问该站点。'
    default:
      break
  }
  if (/certificate|tls|ssl/i.test(String(err?.message ?? ''))) {
    return 'HTTPS 证书校验失败，无法安全访问该站点。'
  }
  return `抓取失败：${err?.message ?? err}`
}

/** 把 HTTP 状态码翻译成可操作的中文提示 */
function explainHttpStatus(status, statusText, url) {
  if (status === 403) {
    return `对方拒绝了访问（HTTP 403）。该站点可能有反爬限制，建议直接复制正文粘贴。`
  }
  if (status === 404) {
    return `页面不存在（HTTP 404）。请确认网址是否正确。`
  }
  if (status === 401 || status === 407) {
    return `该页面需要登录才能访问（HTTP ${status}），请登录后复制正文粘贴。`
  }
  if (status === 429) {
    return `访问过于频繁被限流（HTTP 429），请稍后重试。`
  }
  if (status >= 500) {
    return `对方服务器出错（HTTP ${status}），请稍后重试。`
  }
  return `抓取失败：HTTP ${status}${statusText ? ` ${statusText}` : ''}`
}

/**
 * 判断页面是不是「JavaScript 渲染的空壳」。
 *
 * 典型特征：HTML 骨架存在但正文区为空，内容靠 JS 拉取后插入。
 * 这类页面无论 HTML 解析做得多好都取不到正文，必须明确告知用户而不是给个空结果。
 */
export function detectJsShell(html, extractedText) {
  if (typeof html !== 'string' || !html) return { isShell: false, signals: [] }
  const signals = []

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const visible = stripped
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/doesn'?t work properly without JavaScript|enable JavaScript|需要(启用|开启)\s*JavaScript|请启用\s*JavaScript/i.test(html)) {
    signals.push('no-js-hint')
  }
  if (/<div[^>]+id=["'](app|root|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)) {
    signals.push('empty-mount')
  }
  if (/__NUXT__|__NEXT_DATA__|vue\.config|createApp\(|ReactDOM/.test(html)) {
    signals.push('spa-framework')
  }
  // 骨架不小，但去掉标签后几乎没有可见文本 → 典型的空壳
  if (html.length > 800 && visible.length < 400) signals.push('empty-visible-text')

  const isShell = visible.length < 400 && (extractedText ?? '').trim().length < 400 && signals.length > 0
  return { isShell, signals, visibleChars: visible.length }
}

/** 抓取页面字节内容（带统一超时与体积限制） */
async function fetchPageBytes(u, signal) {
  let res
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(config.fetchTimeoutMs), signal])
        : AbortSignal.timeout(config.fetchTimeoutMs),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('已取消抓取。'), { status: 499, code: 'ABORTED' })
    throw Object.assign(new Error(explainFetchError(err, u.href)), { status: 502, code: 'FETCH_FAILED' })
  }

  if (!res.ok) {
    throw Object.assign(new Error(explainHttpStatus(res.status, res.statusText, u.href)), { status: 502, code: `HTTP_${res.status}` })
  }

  const warnings = []
  const reader = res.body?.getReader()
  const chunks = []
  let total = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > config.maxFetchBytes) {
        warnings.push(`页面超过 ${Math.round(config.maxFetchBytes / 1024 / 1024)}MB，已截断。`)
        try {
          await reader.cancel()
        } catch {
          /* 忽略 */
        }
        break
      }
      chunks.push(Buffer.from(value))
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()))
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: res.headers.get('content-type') ?? '',
    finalUrl: res.url,
    warnings,
  }
}

/**
 * 抓取网址并提取正文。
 *
 * 流程：静态抓取 → 提取 → 若正文明显不足则判断是否为 JS 空壳 →
 * 必要时用本机浏览器渲染一次再提取。
 *
 * @param {string} rawUrl
 * @param {{ signal?:AbortSignal, allowBrowser?:boolean }} [opts]
 */
export async function extractFromUrl(rawUrl, opts = {}) {
  const u = assertPublicUrl(rawUrl)
  const warnings = []

  const page = await fetchPageBytes(u, opts.signal)
  warnings.push(...page.warnings)
  const contentType = page.contentType
  const declaredCharset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]

  let result = await extractFromBuffer(page.buffer, {
    url: u.href,
    mime: contentType,
    filename: u.pathname,
  })

  if (result.meta.format === 'text' && !/html/i.test(contentType) && page.buffer.length > 0) {
    warnings.push('该网址返回的不是 HTML 页面，已按纯文本处理。')
  }

  const textLen = () => result.text.trim().length
  const minChars = config.minUsefulChars
  let renderedWithBrowser = false
  let browserNote = null

  // 正文不足 → 判断是否 JS 空壳，并尝试用本机浏览器补渲染
  if (textLen() < minChars) {
    const decoded = decodeBuffer(page.buffer, declaredCharset)
    const shell = detectJsShell(decoded.text, result.text)

    if (shell.isShell) {
      warnings.push('这个页面的正文由 JavaScript 动态渲染，直接抓取 HTML 拿不到内容。')
    }

    // 只要正文明显不足就尝试渲染。
    // 不依赖空壳判定（它只用于组织提示文案）——判定的假阴性会让本来能救回来的
    // 页面白白失败，而多花几秒渲染远比返回一个空结果划算。
    // PDF / DOCX 例外：渲染对它们没有意义。
    const allowBrowser =
      opts.allowBrowser !== false &&
      config.browserRender &&
      result.meta.format !== 'pdf' &&
      result.meta.format !== 'docx'
    if (allowBrowser) {
      const bmod = await loadBrowserModule()
      const status = bmod ? bmod.browserStatus() : { available: false, reason: '纯静态站点无法调用本机浏览器渲染' }
      if (status.available) {
        try {
          const rendered = await bmod.renderPage(u.href, {
            timeoutMs: config.browserTimeoutMs,
            signal: opts.signal,
          })
          const after = await extractFromBuffer(Buffer.from(rendered.html, 'utf8'), {
            url: u.href,
            mime: 'text/html',
            filename: u.pathname,
          })
          if (after.text.trim().length > textLen()) {
            const before = textLen()
            result = after
            renderedWithBrowser = true
            browserNote = `静态抓取只得到 ${before} 字，已用本机浏览器渲染后重新提取（${textLen()} 字）。`
            warnings.push(browserNote)
          }
        } catch (err) {
          browserNote = `尝试用本机浏览器渲染失败：${redactSecrets(err?.message ?? err)}`
          warnings.push(browserNote)
        }
      } else if (shell.isShell) {
        warnings.push(`${status.reason}。可以手动复制正文粘贴，或改用文件上传。`)
      }
    }
  }

  const sufficient = textLen() >= minChars
  if (!sufficient) {
    warnings.push(
      `只提取到 ${textLen()} 字，大概率不是完整协议。建议改用「粘贴文本」：在浏览器里打开该页面，全选复制后粘贴进来。`,
    )
  }

  return {
    text: result.text,
    title: result.title || u.hostname,
    sufficient,
    meta: {
      ...result.meta,
      warnings: [...new Set([...warnings, ...result.meta.warnings])],
      url: u.href,
      finalUrl: page.finalUrl,
      contentType,
      charset: result.meta.charset ?? normalizeCharset(declaredCharset),
      renderedWithBrowser,
      insufficient: !sufficient,
      bytes: page.buffer.length,
    },
  }
}
