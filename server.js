/**
 * 协议阅读器 —— 零依赖 HTTP 服务。
 *
 * 职责：
 *   - 托管 public/ 下的静态前端
 *   - 提供提取与分析 API（含 SSE 流式进度）
 *   - 在服务端持有 API Key，浏览器永远接触不到密钥
 *
 * 刻意不引入任何框架：整个 demo 用 `node server.js` 即可运行，
 * 后续迁移到 Tauri/桌面端时，这些路由可以直接变成 sidecar 的本地接口。
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { config, describeConfig, resolveRuntime, redactSecrets, ROOT, KNOWN_MODELS } from './src/config.js'
import { extractFromBuffer, extractFromUrl, FORMATS } from './src/extract/index.js'
import { browserStatus } from './src/extract/browser.js'
import { analyzeDocument } from './src/analyze/pipeline.js'
import { answerQuestion } from './src/analyze/ask.js'
import { ping } from './src/analyze/client.js'
import { CATEGORIES, SEVERITIES, SEVERITY_LABEL } from './src/analyze/taxonomy.js'

const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * 接口契约版本。**只要前后端交互的字段有增删就必须加一。**
 * 前端据此判断"我连到的服务是不是旧版本" —— 否则新旧混用时会出现
 * 「页面是新功能、接口是旧实现」这种极难排查的状态（已踩过三次）。
 */
const API_VERSION = 2

const PUBLIC_DIR = path.join(ROOT, 'public')

/**
 * 本机可用于访问本服务的地址。
 * 用途：书签脚本需要把候选地址都写进去，才能在"换了访问方式"时依然可用
 * （例如从 127.0.0.1 换成 WSL 的对外 IP）。
 */
function localOrigins() {
  const out = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue
        const addr = `http://${ni.address}:${config.port}`
        if (!out.includes(addr)) out.push(addr)
      }
    }
  } catch {
    /* 拿不到网卡信息就只用回环地址 */
  }
  return out
}
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra })
}

/** 读取请求体并限制体积 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        reject(Object.assign(new Error(`请求体超过上限 ${Math.round(limit / 1024 / 1024)}MB`), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const buf = await readBody(req, MAX_UPLOAD_BYTES)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })
  }
}

// ---------------- 凭据与安全 ----------------

/** 容错解码请求头（正常情况下无需编码，这里只是防止个别客户端多做一层编码） */
function headerValue(v) {
  if (!v) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 从请求中提取用户携带的模型凭据。
 *
 * 安全要点：**服务端不保存这些值**。它们只在本请求的处理过程中存在于局部变量里，
 * 既不写日志，也不回显给客户端。优先级为「请求头 > 请求体」。
 */
function credentialsFrom(req, body = {}) {
  const h = req.headers
  return {
    apiKey: headerValue(h['x-deepseek-key']) || (typeof body.apiKey === 'string' ? body.apiKey.trim() : '') || undefined,
    baseUrl:
      headerValue(h['x-deepseek-base-url']) || (typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '') || undefined,
    model:
      headerValue(h['x-deepseek-model']) ||
      (typeof body.model === 'string' && body.model.trim() ? body.model.trim() : '') ||
      undefined,
    modelSummary:
      headerValue(h['x-deepseek-model-summary']) ||
      (typeof body.modelSummary === 'string' && body.modelSummary.trim() ? body.modelSummary.trim() : '') ||
      undefined,
  }
}

/**
 * 同源校验。
 *
 * 本地服务监听在 localhost，若不做校验，用户浏览器里任意一个恶意网页都能向
 * http://127.0.0.1:<port>/api/... 发起请求（CSRF / DNS rebinding）。
 * 一旦涉及用户自带的 API Key，这就不是理论风险了。
 */
function originAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true // 同源导航或非浏览器客户端不带 Origin
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * 客户端断开时取消任务。
 *
 * 注意：**不能用 `req.on('close')`**。Node 16 起 IncomingMessage 在请求体读完就会
 * 触发 'close'（早于响应发出），用它来 abort 会让每个稍慢的请求刚读完 body 就被取消。
 * 正确做法是监听响应侧的 'close'，并用 writableFinished 区分「正常结束」和「客户端断线」。
 */
function abortOnDisconnect(res, controller) {
  res.on('close', () => {
    if (!res.writableFinished) controller.abort()
  })
}

// ---------------- 静态文件 ----------------

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'

  const target = path.resolve(PUBLIC_DIR, '.' + rel)
  // 防目录穿越
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    sendError(res, 403, 'Forbidden')
    return
  }

  let stat
  try {
    stat = await fsp.stat(target)
  } catch {
    sendError(res, 404, 'Not found')
    return
  }

  if (stat.isDirectory()) {
    return serveStatic(req, res, path.posix.join(rel, 'index.html'))
  }

  const ext = path.extname(target).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
  })
  fs.createReadStream(target).pipe(res)
}

// ---------------- API ----------------

/**
 * POST /api/extract
 * 原始二进制作为请求体，文件名放在 x-filename 头里。
 * 这样避免了手写 multipart 解析，前端也只需一次 fetch。
 */
async function handleExtract(req, res) {
  const filename = decodeURIComponent(req.headers['x-filename'] ?? '')
  const mime = req.headers['content-type'] ?? ''
  const url = req.headers['x-source-url'] ? decodeURIComponent(req.headers['x-source-url']) : undefined

  const buf = await readBody(req, MAX_UPLOAD_BYTES)
  if (!buf.length) {
    sendError(res, 400, '未收到文件内容')
    return
  }

  const result = await extractFromBuffer(buf, { filename, mime, url })
  sendJson(res, 200, {
    ok: true,
    text: result.text,
    title: result.title,
    meta: { ...result.meta, bytes: buf.length, filename },
  })
}

/** POST /api/fetch-url  { url } */
async function handleFetchUrl(req, res, signal) {
  const body = await readJsonBody(req)
  const url = String(body.url ?? '').trim()
  if (!url) {
    sendError(res, 400, '请提供 url')
    return
  }
  const result = await extractFromUrl(url, { signal, allowBrowser: body.allowBrowser })
  const meta = {
    ...result.meta,
    warnings: (result.meta.warnings ?? []).map(redactSecrets),
  }
  sendJson(res, 200, {
    ok: true,
    // sufficient=false 表示抓到的内容明显不是完整协议。
    // 仍返回 ok:true，让前端拿到详细诊断并自行决定如何提示。
    sufficient: result.sufficient,
    text: result.text,
    title: result.title,
    meta,
  })
}

/** POST /api/analyze  { text, title, source, mode } —— 一次性返回 */
async function handleAnalyze(req, res, signal) {
  const body = await readJsonBody(req)
  const text = String(body.text ?? '')
  if (!text.trim()) {
    sendError(res, 400, '请提供要分析的协议文本')
    return
  }
  const result = await analyzeDocument(
    { text, title: body.title, source: body.source ?? { type: 'text' }, extraction: body.extraction },
    { signal, mode: body.mode, ...credentialsFrom(req, body) },
  )
  sendJson(res, 200, { ok: true, result })
}

/** POST /api/analyze/stream —— SSE 流式进度（前端用 fetch + ReadableStream 读取） */
async function handleAnalyzeStream(req, res) {
  const body = await readJsonBody(req)
  const text = String(body.text ?? '')
  if (!text.trim()) {
    sendError(res, 400, '请提供要分析的协议文本')
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const controller = new AbortController()
  abortOnDisconnect(res, controller)

  let closed = false
  const send = (event) => {
    if (closed || res.writableEnded) return
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      closed = true
    }
  }

  // 心跳，防止中间代理掐断长连接
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n')
  }, 15_000)

  try {
    const result = await analyzeDocument(
      { text, title: body.title, source: body.source ?? { type: 'text' }, extraction: body.extraction },
      { onEvent: send, signal: controller.signal, mode: body.mode, ...credentialsFrom(req, body) },
    )
    send({ type: 'result', result })
  } catch (err) {
    send({
      type: 'error',
      error: err?.message ?? String(err),
      code: err?.code ?? 'ANALYZE_FAILED',
      status: err?.status ?? 500,
    })
  } finally {
    clearInterval(heartbeat)
    closed = true
    if (!res.writableEnded) res.end()
  }
}

/**
 * POST /api/verify-key —— 界面上「测试连接」用。
 * 只验证凭据是否可用并返回可见模型列表，不消耗生成额度。
 */
async function handleVerifyKey(req, res) {
  const body = await readJsonBody(req)
  const creds = credentialsFrom(req, body)
  const rt = resolveRuntime(creds)

  if (!rt.hasKey) {
    sendError(res, 400, '请先填写 API Key。')
    return
  }

  const data = await ping(rt)
  const models = (data?.data ?? [])
    .map((m) => m?.id)
    .filter((id) => typeof id === 'string' && id)
    .sort()

  sendJson(res, 200, {
    ok: true,
    valid: true,
    baseUrl: rt.baseUrl,
    keySource: rt.keySource,
    models,
    // 绝不回显密钥本身，只回显末四位便于用户确认自己填对了哪一把
    keyHint: rt.apiKey ? `…${rt.apiKey.slice(-4)}` : null,
    modelAvailable: models.length ? models.includes(rt.model) : null,
  })
}

// ---------------- 浏览器书签导入 ----------------
//
// 有些页面（需要登录、强反爬、复杂 SPA）无论服务端怎么抓都拿不到。
// 解决办法是让**用户自己的浏览器**去取：书签里执行一段脚本，
// 把当前页面的渲染后文本 POST 过来。
//
// 安全说明：这个接口是唯一豁免同源校验的接口，因为它必须接受来自任意站点的请求。
// 但它只做一件事——把文本存进一个内存槽位，且**必须由用户在界面上手动点击才会载入**，
// 不会自动分析、不读取任何数据、不接触 API Key。最坏情况是往界面里塞一段文本。

/** 最近一次书签推送（仅内存，不落盘） */
let lastIngest = null
let ingestSeq = 0

/**
 * 给书签导入接口带上 CORS 头。
 *
 * 书签用 no-cors + text/plain 发送，本身不需要 CORS 头；但 Chrome 的
 * Private Network Access 策略会对「公网页面 → 本机地址」的请求发起预检，
 * 此时必须显式允许，否则请求会被浏览器直接拦截（表现为 fetch 抛 Failed to fetch）。
 */
function setIngestCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
}

async function handleIngest(req, res) {
  setIngestCors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  const buf = await readBody(req, 8 * 1024 * 1024)
  if (!buf.length) {
    res.writeHead(400).end('empty')
    return
  }
  let payload
  const raw = buf.toString('utf8')
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = { text: raw } // 也接受直接发纯文本
  }

  const text = String(payload.text ?? '').slice(0, config.maxTextChars)
  if (!text.trim()) {
    res.writeHead(400).end('no text')
    return
  }

  ingestSeq++
  lastIngest = {
    seq: ingestSeq,
    at: new Date().toISOString(),
    title: String(payload.title ?? '').slice(0, 300),
    url: String(payload.url ?? '').slice(0, 2000),
    text,
    chars: text.length,
  }
  // 204 + 空 body：书签用 no-cors 发送，读不到响应，也不需要 CORS 头
  res.writeHead(204).end()
}

function handleIngestLatest(res, since) {
  if (!lastIngest) {
    sendJson(res, 200, { ok: true, item: null })
    return
  }
  if (Number.isFinite(since) && lastIngest.seq <= since) {
    sendJson(res, 200, { ok: true, item: null, seq: lastIngest.seq })
    return
  }
  sendJson(res, 200, { ok: true, item: lastIngest, seq: lastIngest.seq })
}

/**
 * POST /api/ask —— 基于一份或多份协议提问。
 * 回答严格依据协议原文，引文经本地核验；核验不过一律改判为「未找到依据」。
 */
async function handleAsk(req, res, signal) {
  const body = await readJsonBody(req)
  const result = await answerQuestion(
    {
      question: body.question,
      documents: body.documents,
      useWeb: body.useWeb === true,
    },
    { signal, ...credentialsFrom(req, body) },
  )
  sendJson(res, 200, { ok: true, result })
}

/** GET /api/config */
function handleConfig(res) {
  sendJson(res, 200, {
    ok: true,
    apiVersion: API_VERSION,
    version: APP_VERSION,
    config: describeConfig(),
    formats: FORMATS,
    // 书签候选地址：把本机所有可用地址都告诉前端，写进书签里一起投递
    origins: localOrigins(),
    // JS 渲染兜底是否可用（前端据此决定要不要显示"用浏览器重试"按钮）
    browser: {
      ...browserStatus(),
      enabled: config.browserRender,
    },
    models: {
      default: config.model,
      defaultSummary: config.modelSummary,
      suggestions: [...new Set([config.model, config.modelSummary, ...KNOWN_MODELS])].filter(Boolean),
    },
    // 分类体系由服务端单一下发，避免前后端两份定义产生漂移
    taxonomy: {
      categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, group: c.group, what: c.what, why: c.why })),
      severityLabels: SEVERITY_LABEL,
      severities: SEVERITIES,
    },
    limits: {
      maxUploadMB: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
      maxTextChars: config.maxTextChars,
      chunkChars: config.chunkChars,
    },
  })
}

/** GET /api/health —— 顺带验证 Key 是否真的可用 */
async function handleHealth(res, checkApi, creds = {}) {
  const rt = resolveRuntime(creds)
  const base = {
    ok: true,
    // 「我是谁」：同时跑多个实例时（尤其 Windows 与 WSL 各一个），
    // 靠这几个字段就能判断浏览器到底连到了哪一个进程。
    app: 'agreement-reader',
    version: APP_VERSION,
    apiVersion: API_VERSION,
    pid: process.pid,
    platform: process.platform,
    port: config.port,
    features: ['extract', 'analyze', 'ask', 'websearch', 'bookmarklet', 'browser-render'],
    mock: config.mock,
    hasApiKey: Boolean(config.apiKey),
    hasRequestKey: Boolean(creds.apiKey),
    keySource: rt.keySource,
    model: rt.model,
  }
  if (!checkApi || config.mock) {
    sendJson(res, 200, base)
    return
  }
  if (!rt.hasKey) {
    sendJson(res, 200, { ...base, api: { ok: false, error: '未配置 API Key' } })
    return
  }
  try {
    const data = await ping(rt)
    sendJson(res, 200, { ...base, api: { ok: true, models: (data?.data ?? []).map((m) => m.id).slice(0, 20) } })
  } catch (err) {
    sendJson(res, 200, { ...base, api: { ok: false, error: redactSecrets(err?.message ?? String(err)) } })
  }
}

// ---------------- 进程标识 ----------------
//
// 自己写 PID 文件，这样 Windows(.cmd) 与 WSL(run.sh) 两侧的停止脚本
// 都能精确定位到本进程，而不必去猜端口占用者是谁。

// PID 文件名必须同时区分**平台**与**端口**：
//  - 平台：Windows 与 WSL 共享同一个项目目录，也就共享同一个 PID 文件，
//    但两边的 PID 属于各自命名空间，Windows 的 1234 和 WSL 的 1234 是不同进程。
//    若不加区分，停止脚本可能按 PID 杀掉一个毫不相干的进程。
//  - 端口：否则同时跑两个实例会互相覆盖，后启动的退出时还会删掉前一个的记录。
const PID_FILE = path.join(ROOT, `.server-${process.platform}-${config.port}.pid`)

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid))
  } catch {
    /* 写不了就算了，不影响服务 */
  }
}

function removePidFile() {
  try {
    // 只删自己写的那份，避免误删后来者的记录
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE)
    }
  } catch {
    /* 忽略 */
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    removePidFile()
    process.exit(0)
  })
}
process.on('exit', removePidFile)

// ---------------- 路由 ----------------

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const { pathname } = url

  res.on('finish', () => {
    if (pathname.startsWith('/api/')) {
      console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`)
    }
  })

  try {
    if (pathname === '/api/health') {
      return await handleHealth(res, url.searchParams.get('check') === '1', credentialsFrom(req))
    }

    if (pathname === '/api/config') {
      if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed')
      return handleConfig(res)
    }

    // 书签导入必须能在任意站点上被触发，因此单独放在同源校验之前
    if (pathname === '/api/ingest') {
      // OPTIONS 是浏览器为 Private Network Access 发的预检
      if (req.method !== 'POST' && req.method !== 'OPTIONS') {
        return sendError(res, 405, 'Method not allowed')
      }
      return await handleIngest(req, res)
    }

    if (pathname.startsWith('/api/')) {
      // 同源校验：阻止其它网页对本地服务发起请求
      if (!originAllowed(req)) return sendError(res, 403, '拒绝跨站请求。')

      if (pathname === '/api/ingest/latest') {
        if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed')
        return handleIngestLatest(res, Number.parseInt(url.searchParams.get('since') ?? '', 10))
      }

      if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed')
      const controller = new AbortController()
      abortOnDisconnect(res, controller)

      if (pathname === '/api/extract') return await handleExtract(req, res)
      if (pathname === '/api/fetch-url') return await handleFetchUrl(req, res, controller.signal)
      if (pathname === '/api/verify-key') return await handleVerifyKey(req, res)
      if (pathname === '/api/ask') return await handleAsk(req, res, controller.signal)
      if (pathname === '/api/analyze') return await handleAnalyze(req, res, controller.signal)
      if (pathname === '/api/analyze/stream') return await handleAnalyzeStream(req, res)
      return sendError(res, 404, `未知接口：${pathname}`)
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed')
    return await serveStatic(req, res, pathname)
  } catch (err) {
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* 忽略 */
      }
      return
    }
    const status = err?.status ?? 500
    // 任何返回给客户端的错误信息都过一遍脱敏，避免密钥意外出现在报文里
    if (status >= 500) console.error('[error]', redactSecrets(err?.stack ?? err?.message ?? err))
    sendError(res, status, redactSecrets(err?.message ?? '服务器内部错误'), { code: err?.code })
  }
})

server.listen(config.port, () => {
  writePidFile()
  const banner = [
    '',
    '  协议阅读器 · Agreement Reader',
    `  ➜  http://127.0.0.1:${config.port}`,
    '',
    `  模型        : ${config.model}${config.modelSummary !== config.model ? ` / 汇总 ${config.modelSummary}` : ''}`,
    `  API 地址    : ${config.baseUrl}`,
    `  API Key     : ${config.apiKey ? '已配置' : '未配置（将使用本地规则模式）'}`,
    `  运行模式    : ${config.mock ? '离线 Mock' : config.apiKey ? '模型分析' : '本地规则（降级）'}`,
    `  并发 / 分片 : ${config.concurrency} 路并发，单批 ${config.chunkChars} 字`,
    '',
  ].join('\n')
  console.log(banner)
})

export { server }
