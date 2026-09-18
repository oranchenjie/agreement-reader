/**
 * 集成测试：模型调用链路的健壮性。
 *
 * 重点复现并验证线上真实遇到的两个问题：
 *   1. 推理模型把 max_tokens 全部消耗在思考过程上 → content 为空、finish_reason=length。
 *      正确行为是**提高输出额度重试**，而不是直接放弃。
 *   2. 汇总模型失败时，应先用逐条模型兜底，而不是立刻退化成关键词统计
 *      （后者会丢掉所有模型生成的解释与建议）。
 *
 * 用法：node test/integration-resilience.mjs
 */
import http from 'node:http'

const AGREEMENT = `示例平台用户服务协议

第一条 协议的接受与变更
本公司有权随时单方面修改本协议，且无需另行通知您。

第二条 账号与终止
本公司有权随时暂停或终止您的账号。账户内余额不予退还。

第三条 争议解决
因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。
`

/** 记录每次请求，供断言使用 */
const calls = []
/** 模拟"网关不认识 thinking 参数"，收到就 400 */
let rejectThinking = false

function jsonResponse(res, message, finishReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  )
}

/** 模拟推理模型：额度不足时把预算全烧在思考过程上，正文为空 */
function emitReasoningExhaustion(res) {
  jsonResponse(res, { role: 'assistant', content: '', reasoning_content: '让我仔细分析这份协议……'.repeat(300) }, 'length')
}

function buildMapFindings(user) {
  const re = /<<<(c\d+)>>>\s*([^\n]*)\n([\s\S]*?)(?=\n<<<|$)/g
  const findings = []
  let m
  const CATS = ['unilateral_change', 'account_termination', 'arbitration']
  while ((m = re.exec(user)) !== null) {
    const id = m[1]
    const text = m[3].split('[本地规则预扫描提示]')[0].trim()
    if (!text) continue
    const sentence = text.split(/(?<=[。！？])/).find((s) => s.trim().length > 8) ?? text
    findings.push({
      clauseId: id,
      category: CATS[findings.length % CATS.length],
      severity: 'high',
      quote: sentence.trim().slice(0, 60),
      title: '模型发现的条款',
      explanation: '模型解释',
      impact: '模型影响',
      advice: '模型建议',
    })
  }
  return findings
}

const REDUCE_OK = {
  riskScore: 72,
  verdict: '模型结论：存在明显不利条款',
  summary: '这是模型生成的汇总摘要，用来区分它和本地统计生成的兜底摘要。',
  topConcerns: [],
  categorySummary: [],
  positives: [],
  actions: ['留意协议变更'],
  readability: '一般。',
}

const MOCK_PORT = 8899

const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url.startsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'flash-ok' }, { id: 'pro-reasoner' }] }))
      return
    }
    const payload = JSON.parse(body || '{}')
    const sys = payload.messages?.[0]?.content ?? ''
    const user = payload.messages?.find((m) => m.role === 'user')?.content ?? ''

    // 模拟「网关不认识 thinking 参数」：只要带上它就 400
    if (rejectThinking && payload.thinking !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unknown parameter: thinking' } }))
      return
    }
    // MAP 提示词一定包含 <<<cN>>> 标记，用这个判定阶段比匹配 system 文案可靠
    const isMap = /<<<c\d+>>>/.test(user)
    calls.push({
      model: payload.model,
      max_tokens: payload.max_tokens,
      thinking: payload.thinking?.type ?? null,
      stage: isMap ? 'map' : 'reduce',
    })

    // ---- MAP ----
    if (isMap) {
      jsonResponse(res, { role: 'assistant', content: JSON.stringify({ findings: buildMapFindings(user) }) })
      return
    }

    // ---- REDUCE ----
    // 场景 A：推理模型。只要没关掉思考就会把额度烧在思考上；
    // 一旦客户端关闭思考（thinking: disabled），就正常产出正文。
    if (payload.model === 'pro-reasoner' && payload.thinking?.type !== 'disabled') {
      emitReasoningExhaustion(res)
      return
    }
    // 场景 A2：额度不足时同样烧在思考上，但额度够了就能产出
    if (payload.model === 'pro-reasoner-2' && (payload.max_tokens ?? 0) < 8192) {
      emitReasoningExhaustion(res)
      return
    }
    // 场景 B：无论怎样都失败，用于验证降级链
    if (payload.model === 'pro-always-empty') {
      emitReasoningExhaustion(res)
      return
    }
    jsonResponse(res, { role: 'assistant', content: JSON.stringify(REDUCE_OK) })
  })
})

await new Promise((r) => mock.listen(MOCK_PORT, r))

// 必须在 import 之前设置环境（config 在模块加载时读取）
process.env.DSH_IGNORE_DOTENV = '1'
process.env.DEEPSEEK_API_KEY = 'test-key'
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`
process.env.DEEPSEEK_MODEL = 'flash-ok'
process.env.DEEPSEEK_MODEL_SUMMARY = 'pro-reasoner'
process.env.DEEPSEEK_MAX_TOKENS = '8192'
process.env.DEEPSEEK_MAX_TOKENS_SUMMARY = '4096' // 故意给小，触发升级
process.env.DEEPSEEK_MAX_TOKENS_CEILING = '32768'

const { chatJSON } = await import('../src/analyze/client.js')
const { analyzeDocument } = await import('../src/analyze/pipeline.js')

const checks = []
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra })

try {
  // ============================================================
  // 场景 A：推理模型额度耗尽 → 应自动提高额度并最终成功
  // ============================================================
  calls.length = 0
  const resultA = await chatJSON({
    messages: [
      { role: 'system', content: '你是汇总助手' },
      { role: 'user', content: '请输出 JSON' },
    ],
    model: 'pro-reasoner',
    auth: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${MOCK_PORT}` },
    maxTokens: 4096,
    temperature: 0.2,
    label: 'reduce-test',
  })

  ok('额度耗尽后自动重试', calls.length >= 2, `共 ${calls.length} 次调用`)
  ok(
    '【关键】重试时关闭了思考（而不是一味加倍额度）',
    calls.some((c) => c.thinking === 'disabled'),
    calls.map((c) => `thinking=${c.thinking ?? '未传'}`).join(' → '),
  )
  ok('最终成功返回内容', typeof resultA.data?.summary === 'string' && resultA.data.summary.length > 0)
  ok('采纳的是模型汇总而非兜底', String(resultA.data?.summary ?? '').includes('模型生成的汇总摘要'))
  ok('警告中说明了改用关闭思考', (resultA.warnings ?? []).some((w) => w.includes('关闭思考')))
  ok('警告中带上了模型名', (resultA.warnings ?? []).some((w) => w.includes('pro-reasoner')))
  ok('警告中说明思考占用了额度', (resultA.warnings ?? []).some((w) => w.includes('思考过程')))

  // ============================================================
  // 场景 A2：接口不支持 thinking 参数 → 应去掉它并退回加倍额度
  // ============================================================
  calls.length = 0
  rejectThinking = true
  const resultA2 = await chatJSON({
    messages: [
      { role: 'system', content: '你是汇总助手' },
      { role: 'user', content: '请输出 JSON' },
    ],
    model: 'pro-reasoner-2',
    auth: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${MOCK_PORT}` },
    maxTokens: 4096,
    label: 'reduce-test',
  })
  rejectThinking = false
  ok('网关拒绝 thinking 参数时不致失败', typeof resultA2.data?.summary === 'string')
  ok(
    '网关拒绝后退回"提高额度"路径',
    (resultA2.warnings ?? []).some((w) => w.includes('不支持关闭思考的参数')),
    (resultA2.warnings ?? []).find((w) => w.includes('不支持'))?.slice(0, 40),
  )

  // ============================================================
  // 场景 B：汇总模型彻底失败 → 应降级到逐条模型，而非本地统计
  // ============================================================
  calls.length = 0
  const resultB = await analyzeDocument(
    { text: AGREEMENT, title: '示例协议' },
    { mode: 'llm', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, model: 'flash-ok', modelSummary: 'pro-always-empty' },
  )

  ok('汇总模型失败时仍完成分析', resultB.stats.mode === 'llm' && Boolean(resultB.report))
  ok(
    '改用逐条模型生成汇总（而非本地统计）',
    String(resultB.report.summary ?? '').includes('模型生成的汇总摘要'),
    String(resultB.report.summary ?? '').slice(0, 40),
  )
  ok(
    '警告中说明发生了模型降级',
    (resultB.warnings ?? []).some((w) => w.includes('逐条模型') && w.includes('降级')),
    (resultB.warnings ?? []).find((w) => w.includes('降级'))?.slice(0, 60),
  )
  ok(
    '没有出现"已使用本地统计"的兜底警告',
    !(resultB.warnings ?? []).some((w) => w.includes('已使用本地统计生成报告')),
  )
  ok('仍产出了风险条款', (resultB.findings?.length ?? 0) > 0, `${resultB.findings?.length} 条`)
  ok('逐条阶段确实用了 flash 模型', calls.some((c) => c.stage === 'map' && c.model === 'flash-ok'))

  // ============================================================
  // 场景 C：所有模型都不可用时，才退化为本地统计并诚实告知
  // ============================================================
  const resultC = await analyzeDocument(
    { text: AGREEMENT, title: '示例协议' },
    { mode: 'llm', apiKey: 'test-key', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, model: 'pro-always-empty', modelSummary: 'pro-always-empty' },
  )
  ok(
    '全部失败时才退化为本地统计',
    (resultC.warnings ?? []).some((w) => w.includes('已使用本地统计生成报告')),
    (resultC.warnings ?? []).find((w) => w.includes('本地统计'))?.slice(0, 60),
  )
  ok('退化后依然给出报告', Boolean(resultC.report?.summary) && Number.isFinite(resultC.report.riskScore))
  ok('退化后仍保留已核验的条款', (resultC.findings?.length ?? 0) > 0, `${resultC.findings?.length} 条`)

  // ============================================================
  // 场景 D：错误信息应当可读且指明怎么办
  // ============================================================
  let errD = null
  try {
    await chatJSON({
      messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }],
      model: 'pro-always-empty',
      auth: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${MOCK_PORT}` },
      maxTokens: 512,
      label: 'err-test',
    })
  } catch (err) {
    errD = err
  }
  ok('额度彻底耗尽时抛出明确错误', Boolean(errD), errD?.message?.slice(0, 50))
  ok('错误信息提到推理模型与处置建议', /推理模型|DEEPSEEK_MAX_TOKENS/.test(errD?.message ?? ''), errD?.message?.slice(0, 80))
} finally {
  mock.close()
}

console.log('--- checks ---')
let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? `  (${c.extra})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
