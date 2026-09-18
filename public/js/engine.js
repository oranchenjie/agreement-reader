/**
 * 浏览器端引擎。
 *
 * 纯静态部署（GitHub Pages）时，没有服务端可用 —— 但**分析逻辑本来就不需要服务端**：
 * pipeline / retrieve / verify / prompts / ask 全是纯 JS，同一份代码在浏览器里直接跑。
 *
 * 这个模块把「服务端 API」的那层壳在浏览器里重新实现一遍，
 * 于是 `api.js` 只需要切换数据来源，前端其余代码完全不用改。
 *
 * 与「服务端模式」的差异（都是浏览器沙箱的硬限制，不是设计取舍）：
 *  - **抓取网页**：受同源策略限制，绝大多数站点不允许跨域读取 → 静态模式下不可用
 *  - **联网搜索**：同理，搜索引擎不允许浏览器跨域读取 → 静态模式下不可用
 *  - **无头浏览器渲染**：需要 spawn 本机 Chrome，浏览器里做不到
 *  - **PDF / DOCX**：需要 Buffer 与同步 zlib，靠自研垫片补齐（缺失时优雅禁用）
 *
 * 隐私上反而更干净：**协议文本与密钥直接在你的浏览器里发往 DeepSeek，
 * 不经过任何第三方服务器。**
 */

/** 垫片加载状态，供界面提示用 */
const caps = {
  shim: false,
  pdf: false,
  docx: false,
  fetchUrl: false,
  webSearch: false,
  reason: {},
}

let corePromise = null

/**
 * 加载共享核心。
 *
 * 顺序很关键：**必须先把 Buffer 垫片装到全局，再导入提取层** ——
 * 提取层的 Buffer 是全局引用（不是 import），晚装一步就会在解析 PDF 时抛错。
 */
async function loadCore() {
  if (corePromise) return corePromise

  corePromise = (async () => {
    // 1) 垫片
    let shim = null
    try {
      shim = await import('./browser-shim.js')
      if (shim.ShimBuffer && typeof globalThis.Buffer === 'undefined') {
        globalThis.Buffer = shim.ShimBuffer
      }
      caps.shim = typeof globalThis.Buffer !== 'undefined'
    } catch (err) {
      caps.shim = false
      caps.reason.shim = err?.message ?? String(err)
    }
    caps.pdf = caps.shim
    caps.docx = caps.shim

    // 2) 共享逻辑（与 Node 侧同一份源码）
    // 用**相对路径**而不是 `/src/...`：
    // GitHub Pages 的项目站点挂在子路径下（https://user.github.io/repo/），
    // 站点根绝对路径会被解析到域名根目录，导致全部 404。
    const [pipeline, ask, extract, client] = await Promise.all([
      import('../src/analyze/pipeline.js'),
      import('../src/analyze/ask.js'),
      import('../src/extract/index.js'),
      import('../src/analyze/client.js'),
    ])

    return { pipeline, ask, extract, client, shim }
  })()

  return corePromise
}

/** 把 File/Blob 读成 Buffer（浏览器用垫片，Node 环境用原生） */
function toBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  if (typeof globalThis.Buffer !== 'undefined') return globalThis.Buffer.from(bytes)
  return bytes
}

function credentialsOf(credentials) {
  return {
    apiKey: credentials?.apiKey || undefined,
    baseUrl: credentials?.baseUrl || undefined,
    model: credentials?.model || undefined,
    modelSummary: credentials?.modelSummary || undefined,
  }
}

/** 静态模式的能力清单，界面据此提示用户哪些功能不可用 */
export function capabilities() {
  return { ...caps, reason: { ...caps.reason } }
}

export const engine = {
  mode: 'static',

  /** 静态模式下没有后端可探测，直接自报能力 */
  async health() {
    return {
      ok: true,
      app: 'agreement-reader',
      platform: 'browser',
      mode: 'static',
      apiVersion: 2,
      features: ['extract', 'analyze', 'ask'],
      mock: false,
      hasApiKey: false,
    }
  },

  /**
   * 分析协议。字段与 `/api/analyze` 保持一致，便于 api.js 无差别调用。
   * @returns {Promise<object>} 分析结果（已拆掉服务端的 { ok, result } 外壳）
   */
  async analyze({ text, title, mode, credentials, onEvent, signal }) {
    const { pipeline } = await loadCore()
    return pipeline.analyzeDocument(
      { text, title, source: { type: 'text' }, extraction: null },
      { onEvent, signal, mode, ...credentialsOf(credentials) },
    )
  },

  /** 协议问答。字段与 `/api/ask` 一致 */
  async ask({ question, documents, useWeb, credentials, signal }) {
    const { ask } = await loadCore()
    return ask.answerQuestion(
      { question, documents, useWeb: false }, // 静态模式无法联网搜索，见 caps.reason
      { signal, ...credentialsOf(credentials) },
    )
  },

  /** 文件提取。字段与 `/api/extract` 保持一致 */
  async extractFile(file) {
    const { extract } = await loadCore()
    const filename = file?.name ?? ''
    const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''

    // 没有垫片时 PDF/DOCX 解不了，早点说清楚，别让用户对着一堆乱码发懵
    if (!caps.shim && ['.pdf', '.docx'].includes(ext)) {
      const result = await extract.extractFromBuffer(toBuffer(await file.arrayBuffer()), {
        filename,
        mime: file.type,
      })
      return { text: result.text, title: result.title, meta: result.meta }
    }

    const result = await extract.extractFromBuffer(toBuffer(await file.arrayBuffer()), {
      filename,
      mime: file.type,
    })
    return { text: result.text, title: result.title, meta: result.meta }
  },

  /** 静态模式无法抓取网页（跨域限制） */
  async fetchUrl() {
    throw new Error(
      '纯静态站点无法抓取网页：浏览器受同源策略限制，不能读取其它站点的内容。请改用「粘贴文本」或「上传文件」；若需网址抓取，可在本机运行服务端版本（node server.js）后使用。',
    )
  },

  /** 密钥校验：浏览器可直接调 DeepSeek（该接口允许跨域） */
  async verifyKey({ apiKey, baseUrl }) {
    const base = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    if (!apiKey) throw new Error('请先填写 API Key。')
    let res
    try {
      res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      throw new Error(`连接失败：${err?.message ?? err}（也可能是该接口不允许浏览器跨域访问）`)
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      const hint =
        res.status === 401 ? 'API Key 无效或未授权' : res.status === 403 ? '无权访问该模型' : '请求被拒绝'
      throw new Error(`${hint}（HTTP ${res.status}）${t ? ` — ${t.slice(0, 200)}` : ''}`)
    }
    const data = await res.json().catch(() => ({}))
    const models = (data?.data ?? []).map((m) => m?.id).filter(Boolean).sort()
    return {
      ok: true,
      valid: true,
      baseUrl: base,
      models,
      keySource: 'browser',
      keyHint: apiKey ? `…${apiKey.slice(-4)}` : null,
      modelAvailable: models.length ? models.includes(credentialsOf({}).model ?? '') : null,
    }
  },

  /** 书签导入依赖服务端接收，静态模式下不可用 */
  async ingestLatest() {
    return { ok: true, item: null, seq: 0 }
  },
}

export default engine
