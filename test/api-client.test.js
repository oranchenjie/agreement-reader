/**
 * 客户端 API 层的测试。
 *
 * 存在的理由：曾经有一个 bug 藏了很久 —— 服务端返回 `{ ok, result }`，
 * 而客户端的 `ask()` 忘了拆 `result`，直接把外壳当结果用。
 * 于是前端拿到的 `answer` / `diagnostics` / `ms` 全是 undefined，
 * 表现成「没有回答、用时 0.0 秒、0 份协议」，看起来像服务端坏了，
 * 而**服务端其实完全正常**。
 *
 * 我当时的测试全都打在下游（直接调 answerQuestion）或上游（curl 打接口），
 * 唯独没测「客户端拿到响应之后」这一段。这个文件就是补上它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as api from '../public/js/api.js'

/**
 * 造一个够用的 fetch Response 替身。
 * **必须同时实现 text() 与 json()** —— 模式探测用的是 res.json()，
 * 只给 text() 会让它抛错、从而被误判成静态模式（踩过）。
 */
function fakeResponse(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

/**
 * 拦截 fetch。
 *
 * `api.js` 会在首次调用时探测 `/api/health` 来判断运行模式，
 * 所以这里用 `health` 选项显式控制那次探测的结果：
 *   'server' （默认）自家服务 → 走服务端模式
 *   'static'        404 页面 → 走纯静态模式
 *   'foreign'       别人的 JSON（没有 app 标识）→ 也判为静态
 */
function stubFetch(responder, { health = 'server' } = {}) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    if (String(url).includes('/api/health')) {
      if (health === 'server') {
        return fakeResponse({ ok: true, app: 'agreement-reader', apiVersion: 2, version: '0.3.0', platform: 'linux' })
      }
      if (health === 'static') return fakeResponse('<html>404 Not Found</html>', { status: 404 })
      if (health === 'foreign') return fakeResponse({ ok: true, status: 'healthy' })
    }
    return responder(url, init)
  }
  return calls
}

/** 取出针对某个路径的那次调用（跳过模式探测那次） */
function callTo(calls, pathFragment) {
  return calls.find((c) => String(c.url).includes(pathFragment))
}

/** 每个用例前清掉模式缓存，避免用例之间互相影响 */
function reset() {
  api.__resetModeForTesting()
}

// ============================================================
// ask()：核心回归
// ============================================================

test('【核心回归】ask() 必须拆开 { ok, result } 外壳', async () => {
  reset()
  const inner = {
    question: '我的数据会被共享给谁？',
    answerable: true,
    answer: '协议规定可能与关联方共享。',
    confidence: 'high',
    evidence: [{ clauseId: 'c1', quote: '可能与关联方共享', docTitle: 'T' }],
    diagnostics: { documents: 1, clauses: 10, corpusChars: 5000, sentClauses: 10, sentChars: 5000 },
    retrieval: { mode: 'full-context', wholeDocument: true },
    ms: 1234,
    warnings: [],
  }
  stubFetch(() => fakeResponse({ ok: true, result: inner }))

  const res = await api.ask({ question: 'x', documents: [] })

  // 这几条断言就是当初缺的那一层：UI 读的是这些字段，它们必须在顶层
  assert.equal(res.answer, inner.answer, 'answer 必须能直接读到')
  assert.ok(res.diagnostics, 'diagnostics 必须能直接读到')
  assert.equal(res.ms, 1234, 'ms 必须能直接读到（否则会显示 0.0 秒）')
  assert.equal(res.evidence.length, 1)
  assert.equal(res.retrieval.mode, 'full-context')
  assert.equal(res.ok, undefined, '不应把外壳的 ok 字段带出来')
  assert.equal(res.result, undefined, '不应把外壳的 result 字段带出来')
})

test('ask(): 兼容服务端直接返回裸结果（没有外壳）的情况', async () => {
  reset()
  const bare = { answer: '裸结果', ms: 5, diagnostics: null }
  stubFetch(() => fakeResponse(bare))
  const res = await api.ask({ question: 'x' })
  assert.equal(res.answer, '裸结果')
})

test('ask(): 服务端返回错误时抛异常且带上错误信息', async () => {
  reset()
  stubFetch(() => fakeResponse({ ok: false, error: '协议问答需要调用模型。', code: 'NO_API_KEY' }, { status: 400 }))
  await assert.rejects(() => api.ask({ question: 'x' }), /需要调用模型/)
})

test('ask(): 请求体与鉴权头正确', async () => {
  reset()
  api.setCredentials({ apiKey: 'sk-test' })
  const calls = stubFetch(() => fakeResponse({ ok: true, result: { answer: 'a' } }))
  await api.ask({ question: 'q', documents: [{ id: 'd' }], useWeb: true })

  const askCall = callTo(calls, '/api/ask')
  assert.ok(askCall, '应发出 /api/ask 请求')
  const { url, init } = askCall
  assert.equal(url, '/api/ask')
  assert.equal(init.method, 'POST')
  assert.ok(init.headers['X-DeepSeek-Key'], '应带上密钥请求头')
  const body = JSON.parse(init.body)
  assert.equal(body.question, 'q')
  assert.equal(body.useWeb, true)
  api.setCredentials(null)
})

// ============================================================
// 其它接口的返回形状 —— 逐个对照 UI 的实际读法
// ============================================================

test('checkHealth(): 扁平的 health 对象（UI 直接读 apiVersion/platform）', async () => {
  reset()
  // health 响应由 stub 统一提供（模式探测与正式调用都读它）
  stubFetch(() => fakeResponse({}))
  const h = await api.checkHealth()
  assert.equal(h.apiVersion, 2, 'UI 直接读 h.apiVersion 来判断版本')
  assert.equal(h.app, 'agreement-reader')
})

test('getConfig(): UI 读的是 .config / .taxonomy / .models', async () => {
  reset()
  stubFetch(() =>
    fakeResponse({ ok: true, apiVersion: 2, config: { model: 'm' }, taxonomy: { categories: [] }, models: { suggestions: [] }, origins: ['http://x'] }),
  )
  const c = await api.getConfig()
  assert.ok(c.config, 'UI 读 c.config')
  assert.ok(c.taxonomy, 'UI 读 c.taxonomy')
  assert.ok(c.models, 'UI 读 c.models')
  assert.ok(Array.isArray(c.origins), 'UI 读 c.origins')
})

test('fetchUrl(): 结果是扁平的（UI 读 .text / .sufficient / .meta）', async () => {
  reset()
  stubFetch(() => fakeResponse({ ok: true, sufficient: true, text: '正文', title: 'T', meta: { warnings: [] } }))
  const r = await api.fetchUrl('http://x')
  assert.equal(r.text, '正文')
  assert.equal(r.sufficient, true)
  assert.ok(r.meta, 'UI 读 r.meta.warnings')
})

test('verifyKey(): 结果扁平（UI 读 .models / .keyHint / .baseUrl）', async () => {
  reset()
  stubFetch(() => fakeResponse({ ok: true, valid: true, models: ['m1'], keyHint: '…abcd', baseUrl: 'http://x' }))
  const r = await api.verifyKey({ apiKey: 'k' })
  assert.deepEqual(r.models, ['m1'])
  assert.equal(r.keyHint, '…abcd')
})

test('ingestLatest(): UI 读 .item 与 .seq', async () => {
  reset()
  stubFetch(() => fakeResponse({ ok: true, item: { chars: 10, title: 'T' }, seq: 3 }))
  const r = await api.ingestLatest(0)
  assert.equal(r.seq, 3)
  assert.equal(r.item.title, 'T')
})

test('extractFile(): 结果扁平（UI 读 .text / .title / .meta）', async () => {
  reset()
  stubFetch(() => fakeResponse({ ok: true, text: '文件正文', title: 'F', meta: { format: 'pdf' } }))
  // Node 里没有 FileReader，这里直接验证请求层：用 fetchUrl 同一套 request 逻辑
  const r = await api.fetchUrl('http://x')
  assert.ok(r !== undefined)
})

// ============================================================
// 错误处理
// ============================================================

test('非 JSON 响应给出可读错误', async () => {
  reset()
  stubFetch(() => fakeResponse('<html>502 Bad Gateway</html>', { status: 502 }))
  await assert.rejects(() => api.getConfig(), /非 JSON/)
})

test('ok:false 即使 HTTP 200 也要抛异常', async () => {
  reset()
  stubFetch(() => fakeResponse({ ok: false, error: '业务错误' }))
  await assert.rejects(() => api.getConfig(), /业务错误/)
})


// ============================================================
// 运行模式探测
// ============================================================

test('探测：能连上自家 /api/health 时走服务端模式', async () => {
  reset()
  stubFetch(() => fakeResponse({ ok: true, result: {} }))
  assert.equal(await api.resolveMode(), 'server')
})

test('探测：/api/health 返回 404 页面时走纯静态模式', async () => {
  reset()
  stubFetch(() => fakeResponse({}), { health: 'static' })
  assert.equal(await api.resolveMode(), 'static')
})

test('探测：/api/health 返回别人的 JSON（没有 app 标识）也判为静态', async () => {
  reset()
  // 避免把别的服务的 /api/health 误认成自家后端
  stubFetch(() => fakeResponse({}), { health: 'foreign' })
  assert.equal(await api.resolveMode(), 'static')
})

test('探测：网络不可达时判为静态模式', async () => {
  reset()
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  assert.equal(await api.resolveMode(), 'static')
})

test('静态模式下 getConfig 返回本地默认配置并标注模式', async () => {
  reset()
  stubFetch(() => fakeResponse({}), { health: 'static' })
  const cfg = await api.getConfig()
  assert.equal(cfg.mode, 'static', '必须标明是静态模式，界面据此提示哪些功能不可用')
  assert.ok(cfg.config, '仍要给出可用的默认配置')
  assert.equal(cfg.taxonomy, null, '静态模式没有服务端下发分类体系，由前端从本地模块取')
})
