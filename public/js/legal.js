/**
 * 法律文档弹窗（用户协议 / 免责声明 / 隐私说明）。
 *
 * 文档是随程序分发的静态 HTML 片段。这里按需 fetch 并注入，同时做一层防护：
 * 只接受来自本地合法路径的内容，避免被篡改成任意 HTML 执行入口。
 */

const DOCS = {
  terms: { file: 'terms.html', title: '用户协议' },
  disclaimer: { file: 'disclaimer.html', title: '免责声明' },
  privacy: { file: 'privacy.html', title: '隐私说明' },
}

const cache = new Map()

/** 只允许这些标签，其余一律剥掉 */
const ALLOWED_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I',
  'CODE', 'BR', 'HR', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'SPAN', 'DIV',
])

/**
 * 清洗法律文档 HTML。
 *
 * 内容是自己写的，但渲染入口不该假设内容一定安全 —— 这份文档会随程序分发，
 * 也可能被本地篡改。因此走白名单：只保留结构标签，去掉脚本、样式、
 * 事件属性、以及 javascript: 这类伪协议。
 *
 * @param {string} html
 * @returns {string}
 */
export function sanitizeLegalHtml(html) {
  let out = String(html ?? '')

  // 整块丢弃（连同内容）
  out = out
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // 去掉事件属性与危险协议
  out = out
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1="#"')
    .replace(/javascript:/gi, '')

  // 白名单过滤标签（保留属性里的 class，样式由主程序提供）
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (match, tag, attrs) => {
    const name = String(tag).toUpperCase()
    if (!ALLOWED_TAGS.has(name)) return ''
    const closing = match.startsWith('</')
    if (closing) return `</${name.toLowerCase()}>`
    const cls = /class\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)
    const klass = cls ? (cls[2] ?? cls[3] ?? '') : ''
    // 只放行 class，其余属性（含 style、id、on*）一律丢弃
    const safeClass = klass.replace(/[^a-zA-Z0-9_\-\s]/g, '').slice(0, 80)
    return safeClass ? `<${name.toLowerCase()} class="${safeClass}">` : `<${name.toLowerCase()}>`
  })

  return out
}

export function createLegalPanel({ dom, toast }) {
  let current = null

  async function load(key) {
    const doc = DOCS[key]
    if (!doc) return null
    if (cache.has(key)) return cache.get(key)

    const res = await fetch(`./legal/${doc.file}`, { headers: { Accept: 'text/html' } })
    if (!res.ok) throw new Error(`无法加载${doc.title}（HTTP ${res.status}）`)
    const html = await res.text()

    // 只保留白名单标签，去掉 script/style/事件属性 —— 内容虽是自己写的，
    // 但渲染入口不该假设内容一定安全。
    const safe = sanitize(html)
    cache.set(key, safe)
    return safe
  }

  function sanitize(html) {
    return sanitizeLegalHtml(html)
  }

  async function open(key) {
    const doc = DOCS[key]
    if (!doc) return
    current = key

    dom.legalTitle.textContent = doc.title
    dom.legalBody.innerHTML = '<p class="hint">正在加载…</p>'
    if (!dom.dialog.open) dom.dialog.showModal()

    try {
      const html = await load(key)
      dom.legalBody.innerHTML = html || '<p class="hint">文档内容为空。</p>'
      dom.legalBody.scrollTop = 0
    } catch (err) {
      dom.legalBody.innerHTML = `<p class="hint">加载失败：${err.message}</p>`
      toast?.(err.message, true)
    }
  }

  // 页面里任何 [data-legal] 按钮都能打开对应文档
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-legal]')
    if (!btn) return
    e.preventDefault()
    open(btn.dataset.legal)
  })

  dom.btnClose.addEventListener('click', () => dom.dialog.close())

  return { open }
}
