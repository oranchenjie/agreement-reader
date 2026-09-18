/**
 * 联网搜索模块测试（src/analyze/websearch.js）。
 *
 * 全部用例都注入假的 fetchImpl，**不访问真实网络**：
 *   - 用真实结构的 HTML 片段覆盖 DDG / Bing 的解析；
 *   - 覆盖跳转链接还原、HTML 实体、去重、伪协议过滤；
 *   - 覆盖失败降级链、超时、响应体上限、空查询等抗逆性场景；
 *   - 贯穿一条硬性契约：webSearch 在任何情况下都不抛异常。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { webSearch, formatSearchResults } from '../src/analyze/websearch.js'

// ============================================================
// 测试辅助
// ============================================================

/** 一个可重复取用的 HTML 响应（每次 fetch 都生成全新的 Response，避免 body 只能读一次的问题） */
class TestHtml {
  constructor(body, status = 200) {
    this.body = String(body)
    this.status = status
  }

  toResponse() {
    return new Response(this.body, { status: this.status, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}

function htmlResponse(body, { status = 200 } = {}) {
  return new TestHtml(body, status)
}

/**
 * 按域名把一个假 fetch 路由到 DDG / Bing 两个处理器。
 * handler 可以是 TestHtml、Error（抛出）或函数（可返回悬挂 Promise）。
 */
function router({ ddg, bing }) {
  const calls = []
  const fn = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method || 'GET', body: init.body, headers: init.headers || {} })
    const handler = /duckduckgo\.com/i.test(u) ? ddg : /bing\.com/i.test(u) ? bing : undefined
    if (handler === undefined) throw new Error(`测试未覆盖的 URL: ${u}`)
    if (handler instanceof Error) throw handler
    if (typeof handler === 'function') return handler(u, init)
    if (handler instanceof TestHtml) return handler.toResponse()
    throw new Error(`测试路由的 handler 类型不支持: ${String(handler)}`)
  }
  fn.calls = calls
  return fn
}

const CN = /[\u4e00-\u9fff]/

/** 一个"标准的" DuckDuckGo HTML 结果页（两条结果，结构贴近真实页面） */
const DDG_TWO_RESULTS = `<!DOCTYPE html>
<html lang="en"><head><title>test at DuckDuckGo</title></head>
<body>
<div id="links" class="results">
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1%26b%3D2&amp;rut=abc123">示例 &amp; 标题 &hellip; 中文</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">这是&lt;第一&gt;条摘要 &#39;引号&#39; &#x4E2D;&#25991; &mdash; 完</a>
      <div class="result__extras"><span class="result__url">example.com</span></div>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://second.example.org/docs?x=1">第二条结果 <b>Second</b></a>
      </h2>
      <td class="result-snippet">第二条摘要&nbsp;内容</td>
    </div>
  </div>
</div>
</body></html>`

/** 一个"标准的" Bing HTML 结果页（含 ck/a 跳转与直链各一条） */
const BING_TWO_RESULTS = `<!DOCTYPE html>
<html><head><title>test - 搜索</title></head>
<body><ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9leGFtcGxlLm5ldC9kZWNvZGVk&amp;ntb=1">Bing 结果 &amp; 标题</a></h2>
    <div class="b_caption"><p>Bing 摘要 &hellip; 文字</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://direct.example.com/2">直接链接</a></h2>
    <p class="b_lineclamp">第二段摘要</p>
  </li>
</ol></body></html>`

/** 把若干 (href, title) 包成 DDG 结果块 */
function ddgBlocks(items) {
  const blocks = items
    .map(
      (it) => `  <div class="result results_links web-result">
    <div class="links_main result__body">
      <h2 class="result__title"><a class="result__a" href="${it.href}">${it.title}</a></h2>
      <a class="result__snippet">${it.snippet || '摘要'}</a>
    </div>
  </div>`,
    )
    .join('\n')
  return `<html><body><div id="links" class="results">\n${blocks}\n</div></body></html>`
}

// ============================================================
// 1. DuckDuckGo 正常解析
// ============================================================

test('webSearch: 正常解析 DuckDuckGo 结果（标题 / URL / 摘要）', async () => {
  const fetchImpl = router({ ddg: htmlResponse(DDG_TWO_RESULTS) })
  const r = await webSearch('测试 关键词', { fetchImpl })

  assert.equal(r.ok, true)
  assert.equal(r.provider, 'duckduckgo')
  assert.equal(r.query, '测试 关键词')
  assert.equal(r.results.length, 2)

  assert.equal(r.results[0].title, '示例 & 标题 … 中文')
  assert.equal(r.results[0].url, 'https://example.com/page?a=1&b=2')
  assert.equal(r.results[0].snippet, "这是<第一>条摘要 '引号' 中文 — 完")

  assert.equal(r.results[1].title, '第二条结果 Second')
  assert.equal(r.results[1].url, 'https://second.example.org/docs?x=1')
  assert.equal(r.results[1].snippet, '第二条摘要 内容')

  // 每条结果都必须是纯净的三个字段
  for (const item of r.results) {
    assert.deepEqual(Object.keys(item).sort(), ['snippet', 'title', 'url'])
    assert.equal(typeof item.title, 'string')
    assert.equal(typeof item.url, 'string')
    assert.equal(typeof item.snippet, 'string')
  }

  // 请求形态：POST 表单 + 浏览器 UA
  const call = fetchImpl.calls[0]
  assert.equal(call.method, 'POST')
  assert.match(call.url, /^https:\/\/html\.duckduckgo\.com\/html\//)
  assert.match(String(call.body), /q=/)
  assert.match(String(call.body), /%E6%B5%8B%E8%AF%95/)
  assert.match(String(call.headers['user-agent']), /Mozilla\/5\.0/)
})

// ============================================================
// 2. uddg= 跳转链接还原
// ============================================================

test('webSearch: 把 DuckDuckGo 的 /l/?uddg= 跳转链接还原成真实 URL', async () => {
  const html = ddgBlocks([
    { href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.com%2Fa%3Fq%3D1%26r%3D2&rut=xyz', title: '跳转一' },
    { href: '/l/?uddg=https%3A%2F%2Freal.example.com%2Fb&kh=-1', title: '跳转二' },
    { href: 'https://plain.example.com/c', title: '直链' },
  ])
  const r = await webSearch('跳转', { fetchImpl: router({ ddg: htmlResponse(html) }) })

  assert.equal(r.ok, true)
  assert.deepEqual(
    r.results.map((x) => x.url),
    ['https://real.example.com/a?q=1&r=2', 'https://real.example.com/b', 'https://plain.example.com/c'],
  )
  for (const item of r.results) assert.match(item.url, /^https:\/\//)
  assert.ok(!r.results.some((x) => x.url.includes('uddg')))
})

// ============================================================
// 3. HTML 实体解码（含十进制 / 十六进制数字实体）
// ============================================================

test('webSearch: 正确解码 HTML 命名实体与数字实体', async () => {
  const html = `<html><body>
  <div class="result web-result">
    <h2 class="result__title"><a class="result__a" href="https://entities.example/x">A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#39; &nbsp; &hellip; &mdash; &#x4E2D;&#25991;</a></h2>
    <a class="result__snippet">&lt;script&gt;alert(1)&lt;/script&gt; 与 &#x1F600; 和 &unknown; 保留</a>
  </div>
  </body></html>`
  const r = await webSearch('实体', { fetchImpl: router({ ddg: htmlResponse(html) }) })

  assert.equal(r.ok, true)
  assert.equal(r.results[0].title, 'A & B <tag> "q" \'s\' … — 中文')
  // 先剥标签后解码实体：&lt;script&gt; 必须还原成字面量文本，而不是被当作标签删掉
  assert.equal(r.results[0].snippet, '<script>alert(1)</script> 与 😀 和 &unknown; 保留')
  // 不能残留未解码的实体
  assert.ok(!/&(?:amp|lt|gt|quot|nbsp|hellip|mdash);/.test(r.results[0].title))
  assert.ok(!/&#x?[0-9a-fA-F]+;?/.test(r.results[0].title))
  assert.ok(!r.results[0].snippet.includes('&lt;'))
})

// ============================================================
// 4. 按 URL 去重
// ============================================================

test('webSearch: 按 URL 去重（忽略末尾斜杠 / hash / utm 跟踪参数）', async () => {
  const html = ddgBlocks([
    { href: 'https://dup.example.com/a', title: '第一条' },
    { href: 'https://dup.example.com/a/?utm_source=news&utm_medium=email', title: '重复条' },
    { href: 'https://dup.example.com/a#section', title: '重复条二' },
    { href: 'https://dup.example.com/b', title: '另一条' },
  ])
  const r = await webSearch('去重', { fetchImpl: router({ ddg: htmlResponse(html) }) })

  assert.equal(r.ok, true)
  assert.equal(r.results.length, 2)
  assert.deepEqual(
    r.results.map((x) => x.url),
    ['https://dup.example.com/a', 'https://dup.example.com/b'],
  )
  assert.equal(r.results[0].title, '第一条')
  assert.ok(r.warnings.some((w) => /去重/.test(w) && CN.test(w)))
})

// ============================================================
// 5. 过滤 javascript:/data: 伪协议与无效结果
// ============================================================

test('webSearch: 过滤 javascript:/data: 伪协议、搜索页内部链接与空标题', async () => {
  const html = ddgBlocks([
    { href: 'javascript:alert(1)', title: '伪协议 JS' },
    { href: 'data:text/html;base64,PHNjcmlwdD4=', title: '伪协议 data' },
    { href: '//duckduckgo.com/y.js?ad_provider=test', title: '广告位' },
    { href: 'https://ok.example.com/x', title: '唯一正常结果' },
    { href: 'https://ok.example.com/empty-title', title: '<!-- 只有注释 -->' },
  ])
  const r = await webSearch('过滤', { fetchImpl: router({ ddg: htmlResponse(html) }) })

  assert.equal(r.ok, true)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].url, 'https://ok.example.com/x')
  assert.equal(r.results[0].title, '唯一正常结果')
  for (const item of r.results) {
    assert.match(item.url, /^https?:\/\//)
    assert.ok(!/^(javascript|data):/i.test(item.url))
  }
  assert.ok(r.warnings.some((w) => /无效链接/.test(w) && CN.test(w)))
  assert.ok(r.warnings.some((w) => /无标题/.test(w) && CN.test(w)))
})

test('webSearch: 默认最多返回 6 条，可用 maxResults 覆盖', async () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ href: `https://many.example.com/${i}`, title: `第 ${i} 条` }))
  const html = ddgBlocks(items)

  const def = await webSearch('数量', { fetchImpl: router({ ddg: htmlResponse(html) }) })
  assert.equal(def.results.length, 6)

  const two = await webSearch('数量', { fetchImpl: router({ ddg: htmlResponse(html) }), maxResults: 2 })
  assert.equal(two.results.length, 2)

  const capped = await webSearch('数量', { fetchImpl: router({ ddg: htmlResponse(html) }), maxResults: 999 })
  assert.equal(capped.results.length, 9)
})

// ============================================================
// 6. DuckDuckGo 失败后自动切换到 Bing
// ============================================================

test('webSearch: DuckDuckGo 返回 500 时自动切换到 Bing 并成功', async () => {
  const fetchImpl = router({
    ddg: htmlResponse('<html><body>server error</body></html>', { status: 500 }),
    bing: htmlResponse(BING_TWO_RESULTS),
  })
  const r = await webSearch('备用来源', { fetchImpl })

  assert.equal(r.ok, true)
  assert.equal(r.provider, 'bing')
  assert.equal(r.results.length, 2)
  assert.equal(r.results[0].title, 'Bing 结果 & 标题')
  assert.equal(r.results[0].url, 'https://example.net/decoded')
  assert.equal(r.results[0].snippet, 'Bing 摘要 … 文字')
  assert.equal(r.results[1].url, 'https://direct.example.com/2')

  // 两个来源都被请求过，且失败原因是中文
  assert.equal(fetchImpl.calls.length, 2)
  assert.match(fetchImpl.calls[1].url, /bing\.com\/search\?q=/)
  assert.ok(r.warnings.some((w) => /DuckDuckGo/.test(w) && /500/.test(w)))
  assert.ok(r.warnings.some((w) => /切换/.test(w) && CN.test(w)))
})

test('webSearch: DuckDuckGo 解析不出结果（结构变化）时也降级到 Bing', async () => {
  const fetchImpl = router({
    ddg: htmlResponse('<html><body><div class="totally-new-layout">没有结果</div></body></html>'),
    bing: htmlResponse(BING_TWO_RESULTS),
  })
  const r = await webSearch('结构变化', { fetchImpl })

  assert.equal(r.ok, true)
  assert.equal(r.provider, 'bing')
  assert.ok(r.results.length >= 1)
  assert.ok(r.warnings.some((w) => /未解析到任何搜索结果/.test(w) && CN.test(w)))
})

test('webSearch: DuckDuckGo 疑似反爬验证时降级到 Bing', async () => {
  const fetchImpl = router({
    ddg: htmlResponse('<html><body><div class="anomaly-modal">Detected unusual traffic</div></body></html>'),
    bing: htmlResponse(BING_TWO_RESULTS),
  })
  const r = await webSearch('反爬', { fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.provider, 'bing')
  assert.ok(r.warnings.some((w) => /反爬/.test(w) && CN.test(w)))
})

// ============================================================
// 7. 两个来源都失败：ok:false 且不抛异常
// ============================================================

test('webSearch: 两个来源都失败时返回 ok:false、provider:none，且不抛异常', async () => {
  const fetchImpl = router({
    ddg: htmlResponse('bad gateway', { status: 502 }),
    bing: new Error('getaddrinfo ENOTFOUND'),
  })

  let r
  await assert.doesNotReject(async () => {
    r = await webSearch('两者都失败', { fetchImpl })
  })

  assert.equal(r.ok, false)
  assert.equal(r.provider, 'none')
  assert.equal(r.query, '两者都失败')
  assert.deepEqual(r.results, [])
  assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 2)
  for (const w of r.warnings) {
    assert.equal(typeof w, 'string')
    assert.ok(CN.test(w), `警告必须是中文说明：${w}`)
  }
  assert.ok(r.warnings.some((w) => /502/.test(w)))
  assert.ok(r.warnings.some((w) => /Bing/.test(w)))
})

// ============================================================
// 8. 超时 / 取消
// ============================================================

test('webSearch: fetchImpl 永不 resolve 时按 timeoutMs 超时返回（不挂死）', async () => {
  const fetchImpl = router({
    ddg: () => new Promise(() => {}),
    bing: () => new Promise(() => {}),
  })
  const started = Date.now()
  const r = await webSearch('超时', { fetchImpl, timeoutMs: 60 })
  const elapsed = Date.now() - started

  assert.equal(r.ok, false)
  assert.equal(r.provider, 'none')
  assert.deepEqual(r.results, [])
  assert.ok(r.warnings.some((w) => /超时/.test(w) && CN.test(w)), JSON.stringify(r.warnings))
  assert.ok(elapsed < 5000, `应在超时后尽快返回，实际 ${elapsed}ms`)
})

test('webSearch: fetchImpl 抛 AbortError 时按超时处理（不抛异常）', async () => {
  const abortErr = () => {
    const e = new Error('The operation was aborted')
    e.name = 'AbortError'
    return e
  }
  const fetchImpl = router({
    ddg: () => {
      throw abortErr()
    },
    bing: () => {
      throw abortErr()
    },
  })
  const r = await webSearch('中止', { fetchImpl, timeoutMs: 200 })

  assert.equal(r.ok, false)
  assert.equal(r.provider, 'none')
  assert.ok(r.warnings.some((w) => /超时/.test(w) && CN.test(w)))
})

test('webSearch: 外部 signal 已中止时立即返回取消说明', async () => {
  const fetchImpl = router({
    ddg: () => new Promise(() => {}),
    bing: () => new Promise(() => {}),
  })
  const controller = new AbortController()
  controller.abort()

  const r = await webSearch('取消', { fetchImpl, signal: controller.signal })
  assert.equal(r.ok, false)
  assert.equal(r.provider, 'none')
  assert.equal(fetchImpl.calls.length, 0)
  assert.ok(r.warnings.some((w) => /取消/.test(w) && CN.test(w)))
})

test('webSearch: 请求过程中外部 signal 中止时不抛异常', async () => {
  const fetchImpl = router({
    ddg: (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    bing: () => new Promise(() => {}),
  })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const started = Date.now()
  const r = await webSearch('中途取消', { fetchImpl, signal: controller.signal, timeoutMs: 4000 })
  const elapsed = Date.now() - started

  assert.equal(r.ok, false)
  assert.equal(r.provider, 'none')
  assert.ok(r.warnings.some((w) => /取消/.test(w) && CN.test(w)))
  // 取消后不应再尝试备用来源，也不该等到 timeoutMs
  assert.equal(fetchImpl.calls.length, 1)
  assert.ok(elapsed < 1000, `取消后应立即返回，实际 ${elapsed}ms`)
})

// ============================================================
// 9. 响应体大小上限（2MB）
// ============================================================

test('webSearch: 响应体超过 2MB 上限时截断并给出警告', async () => {
  const head = `<div class="result results_links web-result">
    <h2 class="result__title"><a class="result__a" href="https://big.example.com/1">大响应里的结果</a></h2>
    <a class="result__snippet">摘要文字</a>
  </div>`
  const bigHtml = `<html><body>${head}${'x'.repeat(3 * 1024 * 1024)}</body></html>`
  assert.ok(bigHtml.length > 2 * 1024 * 1024)

  const r = await webSearch('大响应', { fetchImpl: router({ ddg: htmlResponse(bigHtml) }) })

  assert.equal(r.ok, true)
  assert.equal(r.provider, 'duckduckgo')
  assert.equal(r.results[0].url, 'https://big.example.com/1')
  assert.equal(r.results[0].title, '大响应里的结果')
  assert.ok(r.warnings.some((w) => /截断/.test(w) && /2MB/.test(w) && CN.test(w)), JSON.stringify(r.warnings))
})

// ============================================================
// 10. 空查询 / 非字符串查询
// ============================================================

test('webSearch: 空查询与非字符串查询都安全失败且不发请求', async () => {
  const cases = ['', '   ', '\n\t', null, undefined, 42, {}, [], Symbol('x')]
  for (const bad of cases) {
    const fetchImpl = router({
      ddg: () => {
        throw new Error('不应该发起请求')
      },
      bing: () => {
        throw new Error('不应该发起请求')
      },
    })

    let r
    await assert.doesNotReject(async () => {
      r = await webSearch(bad, { fetchImpl })
    })

    assert.equal(r.ok, false, `输入 ${String(bad)} 应当失败`)
    assert.equal(r.provider, 'none')
    assert.deepEqual(r.results, [])
    assert.equal(r.query, '')
    assert.ok(r.warnings.length >= 1 && CN.test(r.warnings[0]), JSON.stringify(r.warnings))
    assert.equal(fetchImpl.calls.length, 0, '空查询不应发起任何网络请求')
  }
})

test('webSearch: 超长查询被截断并记录中文警告', async () => {
  const long = 'a'.repeat(900)
  const fetchImpl = router({ ddg: htmlResponse(DDG_TWO_RESULTS) })
  const r = await webSearch(long, { fetchImpl })

  assert.equal(r.ok, true)
  assert.equal(r.query.length, 500)
  assert.ok(r.warnings.some((w) => /截断/.test(w) && CN.test(w)))
})

test('webSearch: 含 emoji 的超长查询按码点截断，不切坏代理对、不抛 URIError', async () => {
  // 499 个汉字 + emoji，正好让第 500 个码点落在 emoji 上
  const query = '汉'.repeat(499) + '😀' + '尾'.repeat(50)
  const sent = []
  const fetchImpl = async (url, init = {}) => {
    sent.push(String(url) + '|' + String(init.body || ''))
    return new TestHtml(DDG_TWO_RESULTS).toResponse()
  }
  const r = await webSearch(query, { fetchImpl })

  assert.equal(r.ok, true)
  assert.equal(Array.from(r.query).length, 500)
  assert.equal(r.query.endsWith('😀'), true, '截断处不应产生半个代理项')
  assert.equal(/[\uD800-\uDFFF]/.test(r.query.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false)
  assert.ok(r.warnings.some((w) => /截断/.test(w) && CN.test(w)))
  // 截断后的查询要能正常编码进请求体（emoji 编码为 %F0%9F%98%80）
  assert.ok(sent[0].includes('%F0%9F%98%80'), sent[0].slice(0, 200))

  // 含落单代理项的查询（半个 emoji）也必须安全
  const lone = '前' + '\uD83D' + '后'
  const r2 = await webSearch(lone, { fetchImpl: router({ ddg: htmlResponse(DDG_TWO_RESULTS) }) })
  assert.equal(r2.ok, true)
})

test('webSearch: 异常 opts（null / 非函数 fetchImpl / 无全局 fetch）不抛异常', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  // opts 为 null / 非对象时回退到全局 fetch（这里用替身，避免真实联网）
  const globalStub = router({ ddg: htmlResponse(DDG_TWO_RESULTS) })
  globalThis.fetch = globalStub

  await assert.doesNotReject(async () => {
    const a = await webSearch('x', null)
    assert.equal(a.ok, true)
    assert.equal(a.provider, 'duckduckgo')
    assert.equal(globalStub.calls.length, 1)
  })

  await assert.doesNotReject(async () => {
    const b = await webSearch('x', 0)
    assert.equal(b.ok, true)
    assert.equal(globalStub.calls.length, 2)
  })

  // fetchImpl 不是函数时同样回退全局 fetch，而不是抛错
  const c = await webSearch('x', { fetchImpl: 'not-a-function' })
  assert.equal(c.ok, true)
  assert.equal(globalStub.calls.length, 3)

  // 运行环境连全局 fetch 都没有：安全失败 + 中文说明
  globalThis.fetch = undefined
  const d = await webSearch('x')
  assert.equal(d.ok, false)
  assert.equal(d.provider, 'none')
  assert.deepEqual(d.results, [])
  assert.ok(CN.test(d.warnings[0]), JSON.stringify(d.warnings))

  globalThis.fetch = globalStub

  // fetchImpl 同步抛错，也必须被兜住
  const syncThrow = await webSearch('x', {
    fetchImpl: () => {
      throw new Error('sync boom')
    },
  })
  assert.equal(syncThrow.ok, false)
  assert.equal(syncThrow.provider, 'none')
  assert.ok(CN.test(syncThrow.warnings[0]))

  // 返回不可读对象（既无 body 也无 text()）
  const garbage = await webSearch('x', { fetchImpl: async () => ({ status: 200, ok: true }) })
  assert.equal(garbage.ok, false)
  assert.equal(garbage.provider, 'none')
  assert.ok(garbage.warnings.every((w) => CN.test(w)))
})

// ============================================================
// 11. formatSearchResults
// ============================================================

test('formatSearchResults: 单条结果格式精确匹配', () => {
  const out = formatSearchResults([{ title: '标题A', url: 'https://a.example/1', snippet: '摘要A' }])
  assert.equal(out, '[1] 标题A\n    https://a.example/1\n    摘要A')
})

test('formatSearchResults: 多条结果编号递增且彼此分隔', () => {
  const out = formatSearchResults([
    { title: '标题A', url: 'https://a.example/1', snippet: '摘要A' },
    { title: '标题B', url: 'https://b.example/2', snippet: '摘要B' },
  ])
  assert.ok(out.startsWith('[1] 标题A\n    https://a.example/1\n    摘要A'))
  assert.ok(out.includes('[2] 标题B'))
  assert.ok(out.includes('    https://b.example/2'))
  assert.ok(out.includes('    摘要B'))
  assert.ok(out.indexOf('[1]') < out.indexOf('[2]'))
})

test('formatSearchResults: 缺字段被容错处理', () => {
  const out = formatSearchResults([
    { title: '', url: 'https://only-url.example/', snippet: '' },
    { title: '只有标题' },
    null,
    'not-an-object',
    { title: '  ', url: '  ', snippet: '   ' },
  ])
  assert.ok(out.includes('[1] (无标题)'))
  assert.ok(out.includes('    https://only-url.example/'))
  assert.ok(out.includes('[2] 只有标题'))
  assert.equal(out.includes('not-an-object'), false)
})

test('formatSearchResults: 遵守 maxChars 上限并注明截断', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    title: `标题 ${i}`,
    url: `https://long.example.com/path/${i}`,
    snippet: '很长的摘要内容'.repeat(40),
  }))

  const out = formatSearchResults(many, { maxChars: 300 })
  assert.ok(out.length <= 300, `输出长度 ${out.length} 应不超过 300`)
  assert.ok(out.includes('截断'), out.slice(-120))
  assert.ok(out.startsWith('[1] 标题 0'))

  // 默认上限 4000：内容远超上限时必须截断
  const full = many.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
  assert.ok(full.length > 4000, `测试数据总长度 ${full.length} 应超过 4000`)
  const def = formatSearchResults(many)
  assert.ok(def.length <= 4000, `默认输出长度 ${def.length} 应不超过 4000`)
  assert.ok(def.includes('截断'), def.slice(-120))

  // 放得下时不截断、不加提示
  const small = formatSearchResults([{ title: '标题A', url: 'https://a.example/1', snippet: '摘要A' }], { maxChars: 500 })
  assert.equal(small.includes('截断'), false)
})

test('formatSearchResults: 非法 maxChars 回退默认值', () => {
  const results = [{ title: '标题', url: 'https://a.example/1', snippet: '摘要' }]
  for (const bad of [0, -5, NaN, 'x', null, undefined]) {
    const out = formatSearchResults(results, { maxChars: bad })
    assert.equal(out, '[1] 标题\n    https://a.example/1\n    摘要')
  }
})

// ============================================================
// 12. formatSearchResults 空输入
// ============================================================

test('formatSearchResults: 空数组 / 非法输入返回空字符串', () => {
  assert.equal(formatSearchResults([]), '')
  assert.equal(formatSearchResults([], { maxChars: 100 }), '')
  assert.equal(formatSearchResults(null), '')
  assert.equal(formatSearchResults(undefined), '')
  assert.equal(formatSearchResults('nope'), '')
  assert.equal(formatSearchResults([null, undefined, 42]), '')
  assert.equal(formatSearchResults(), '')
})

// ============================================================
// 13. 解析兜底：结果块 class 变化时仍能抓到结果
// ============================================================

test('webSearch: DDG 结果块 class 变化时走锚点兜底解析', async () => {
  const html = `<html><body>
    <section class="new-style-item">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffallback.example.com%2F1">兜底标题</a>
      <a class="result__snippet">兜底摘要</a>
    </section>
  </body></html>`
  const r = await webSearch('兜底', { fetchImpl: router({ ddg: htmlResponse(html) }) })

  assert.equal(r.ok, true)
  assert.equal(r.provider, 'duckduckgo')
  assert.equal(r.results[0].url, 'https://fallback.example.com/1')
  assert.equal(r.results[0].title, '兜底标题')
  assert.equal(r.results[0].snippet, '兜底摘要')
  assert.ok(r.warnings.some((w) => /兜底解析/.test(w) && CN.test(w)))
})

test('webSearch: 假响应只实现 text() 时仍可解析（读取路径兜底）', async () => {
  const fakeRes = {
    status: 200,
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => DDG_TWO_RESULTS,
  }
  const r = await webSearch('纯 text 响应', { fetchImpl: async () => fakeRes })
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 2)
})

test('webSearch: 返回结构稳定（字段齐全，结果全部为 http/https）', async () => {
  const fetchImpl = router({ ddg: htmlResponse(DDG_TWO_RESULTS) })
  const r = await webSearch('结构', { fetchImpl })

  assert.deepEqual(Object.keys(r).sort(), ['ok', 'provider', 'query', 'results', 'warnings'])
  assert.equal(typeof r.ok, 'boolean')
  assert.equal(typeof r.query, 'string')
  assert.equal(typeof r.provider, 'string')
  assert.ok(Array.isArray(r.results))
  assert.ok(Array.isArray(r.warnings))
  for (const item of r.results) assert.match(item.url, /^https?:\/\//)
})
