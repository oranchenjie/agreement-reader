/**
 * 与后端通信的薄封装。
 *
 * 这个模块同时支持两种运行形态，**前端其余代码完全无感**：
 *
 *   服务端模式：本机（或服务器上）跑着 node server.js，通过 /api/* 调用
 *   纯静态模式：部署在 GitHub Pages 上，直接在浏览器里跑同一份分析逻辑
 *              （见 engine.js）—— 没有服务端，协议文本与密钥直接发往 DeepSeek
 *
 * 模式在首次调用时自动探测：能连上自家的 /api/health 就走服务端，否则走本地引擎。
 */

/** 当前生效的凭据请求头（服务端模式用） */
let credentialHeaders = {}
/** 当前生效的凭据原文（本地引擎模式用） */
let currentCredentials = {}

/** @type {'server'|'static'|null} */
let resolvedMode = null

/**
 * 设置要使用的凭据。
 * @param {{apiKey?:string, baseUrl?:string, model?:string, modelSummary?:string}|null} creds
 */
export function setCredentials(creds) {
  currentCredentials = {
    apiKey: creds?.apiKey ?? '',
    baseUrl: creds?.baseUrl ?? '',
    model: creds?.model ?? '',
    modelSummary: creds?.modelSummary ?? '',
  }
  const h = {}
  if (creds?.apiKey) h['X-DeepSeek-Key'] = encodeURIComponent(creds.apiKey)
  if (creds?.baseUrl) h['X-DeepSeek-Base-Url'] = encodeURIComponent(creds.baseUrl)
  if (creds?.model) h['X-DeepSeek-Model'] = encodeURIComponent(creds.model)
  if (creds?.modelSummary) h['X-DeepSeek-Model-Summary'] = encodeURIComponent(creds.modelSummary)
  credentialHeaders = h
}

export function hasCredentials() {
  return Boolean(currentCredentials.apiKey)
}

/**
 * 探测运行模式。
 * 纯静态站点上 `/api/health` 会返回 404 页面（拿不到合法 JSON），据此判定。
 * @returns {Promise<'server'|'static'>}
 */
export async function resolveMode() {
  if (resolvedMode) return resolvedMode
  try {
    const res = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
      headers: credentialHeaders,
    })
    if (res.ok) {
      const j = await res.json().catch(() => null)
      // 认准自家服务，避免把别人的 /api/health 误判成后端
      if (j && j.app === 'agreement-reader') {
        resolvedMode = 'server'
        return resolvedMode
      }
    }
  } catch {
    /* 连不上 → 静态模式 */
  }
  resolvedMode = 'static'
  return resolvedMode
}

export function getMode() {
  return resolvedMode ?? 'unknown'
}

/** 仅供测试：清掉模式缓存，让每个用例都能重新探测 */
export function __resetModeForTesting() {
  resolvedMode = null
  enginePromise = null
}

let enginePromise = null
async function localEngine() {
  if (!enginePromise) enginePromise = import('./engine.js').then((m) => m.engine)
  return enginePromise
}

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const isBinary = body instanceof ArrayBuffer || body instanceof Uint8Array
  const merged = { ...credentialHeaders, ...headers }
  if (!isBinary) merged['Content-Type'] = merged['Content-Type'] ?? 'application/json'

  const res = await fetch(path, {
    method,
    headers: merged,
    body: isBinary ? body : body ? JSON.stringify(body) : undefined,
    signal,
  })

  const text = await res.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`服务端返回了非 JSON 内容（HTTP ${res.status}）`)
  }

  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败（HTTP ${res.status}）`)
  }
  return payload
}

// ============================================================
// 配置
// ============================================================

export async function getConfig() {
  if ((await resolveMode()) === 'static') {
    const { capabilities } = await import('./engine.js')
    return {
      ok: true,
      apiVersion: 2,
      version: '0.3.0',
      mode: 'static',
      capabilities: capabilities(),
      config: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        modelSummary: 'deepseek-v4-pro',
        mock: false,
        hasApiKey: false,
        concurrency: 3,
        chunkChars: 6000,
      },
      formats: [
        { id: 'text', label: '纯文本 / Markdown' },
        { id: 'html', label: '网页 / HTML' },
        { id: 'pdf', label: 'PDF 文档' },
        { id: 'docx', label: 'Word 文档' },
        { id: 'json', label: 'JSON' },
      ],
      models: { suggestions: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'] },
      taxonomy: null, // 静态模式的分类体系由 app.js 从本地模块取（见那里的兜底）
      origins: [],
      browser: { available: false, enabled: false, reason: '纯静态站点无法调用本机浏览器' },
    }
  }
  return request('/api/config')
}

export async function checkHealth(deep = false) {
  if ((await resolveMode()) === 'static') return (await localEngine()).health()
  return request(`/api/health${deep ? '?check=1' : ''}`)
}

export async function verifyKey(creds) {
  if ((await resolveMode()) === 'static') return (await localEngine()).verifyKey(creds)
  const headers = {}
  if (creds?.apiKey) headers['X-DeepSeek-Key'] = encodeURIComponent(creds.apiKey)
  if (creds?.baseUrl) headers['X-DeepSeek-Base-Url'] = encodeURIComponent(creds.baseUrl)
  return request('/api/verify-key', { method: 'POST', body: {}, headers })
}

// ============================================================
// 输入
// ============================================================

export async function extractFile(file) {
  if ((await resolveMode()) === 'static') return (await localEngine()).extractFile(file)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.onload = async () => {
      try {
        const payload = await request('/api/extract', {
          method: 'POST',
          body: reader.result,
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name),
          },
        })
        resolve(payload)
      } catch (err) {
        reject(err)
      }
    }
    reader.readAsArrayBuffer(file)
  })
}

export async function fetchUrl(url, { allowBrowser, signal } = {}) {
  if ((await resolveMode()) === 'static') return (await localEngine()).fetchUrl(url, { allowBrowser, signal })
  return request('/api/fetch-url', {
    method: 'POST',
    body: { url, ...(allowBrowser === undefined ? {} : { allowBrowser }) },
    signal,
  })
}

export async function ingestLatest(since) {
  if ((await resolveMode()) === 'static') return (await localEngine()).ingestLatest(since)
  const q = Number.isFinite(since) ? `?since=${since}` : ''
  return request(`/api/ingest/latest${q}`)
}

// ============================================================
// 分析
// ============================================================

/**
 * 流式分析。
 * 服务端模式走 SSE；静态模式把本地引擎的阶段事件直接回调出去，
 * 两种模式对调用方（app.js）完全一致。
 *
 * @param {{text:string,title?:string,mode?:string,source?:object,extraction?:object}} payload
 * @param {{onEvent?:(e:object)=>void, signal?:AbortSignal}} [opts]
 * @returns {Promise<object>} 最终分析结果
 */
export async function analyzeStream(payload, opts = {}) {
  const { onEvent, signal } = opts

  if ((await resolveMode()) === 'static') {
    const eng = await localEngine()
    return eng.analyze({ ...payload, credentials: currentCredentials, onEvent, signal })
  }

  const res = await fetch('/api/analyze/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...credentialHeaders },
    body: JSON.stringify(payload),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = `分析请求失败（HTTP ${res.status}）`
    try {
      const parsed = JSON.parse(text)
      if (parsed?.error) message = parsed.error
    } catch {
      /* 保持默认信息 */
    }
    throw new Error(message)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result = null
  let streamError = null

  const handleChunk = (raw) => {
    const line = raw.trim()
    if (!line || line.startsWith(':')) return // 心跳
    if (!line.startsWith('data:')) return
    const json = line.slice(5).trim()
    if (!json) return
    let event
    try {
      event = JSON.parse(json)
    } catch {
      return
    }
    if (event.type === 'result') result = event.result
    else if (event.type === 'error') streamError = event
    onEvent?.(event)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of chunk.split('\n')) handleChunk(line)
    }
  }
  if (buffer.trim()) for (const line of buffer.split('\n')) handleChunk(line)

  if (streamError) {
    const err = new Error(streamError.error || '分析失败')
    err.code = streamError.code
    throw err
  }
  if (!result) throw new Error('分析结束但没有收到结果，请重试。')
  return result
}

// ============================================================
// 问答
// ============================================================

/**
 * 基于一份或多份协议提问。
 *
 * 注意：服务端 `/api/ask` 的响应是 `{ ok, result }` 外壳，**必须拆开 result**。
 * 曾经忘了拆 —— 前端拿到的 answer/diagnostics/ms 全是 undefined，
 * 表现成「没有回答、用时 0.0 秒」，而服务端其实一切正常。
 * test/api-client.test.js 守着这条。
 */
export async function ask(payload, { signal } = {}) {
  if ((await resolveMode()) === 'static') {
    const eng = await localEngine()
    return eng.ask({ ...payload, credentials: currentCredentials, signal })
  }
  const res = await request('/api/ask', { method: 'POST', body: payload, signal })
  return res.result ?? res
}
