/**
 * 用本地 mock LLM 服务器跑通「真实模型调用」代码路径：
 * 客户端重试/JSON解析、MAP 分片并发、引文核验、REDUCE 汇总、风险分校准。
 * 这样无需真实 API Key 也能验证 LLM 链路是否正确。
 */
import http from 'node:http'

const seen = { map: 0, reduce: 0, auth: null, models: new Set(), responseFormat: null }

const AGREEMENT = `示例平台用户服务协议

第一条 协议的接受与变更
本公司有权随时单方面修改本协议，且无需另行通知您。您继续使用本服务即视为接受修改后的协议。

第二条 账号与终止
本公司有权随时暂停或终止您的账号，无需事先通知。账号被终止的，账户内余额不予退还。

第三条 内容授权
您在本平台上传、发布的所有内容，您授予本公司全球范围内永久、不可撤销、免费、可转授权的许可。

第四条 争议解决
因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。您放弃以集体诉讼方式主张权利。

第五条 隐私与数据
我们可能将您的个人信息共享给我们的关联方及合作伙伴用于个性化广告推荐。
`

const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    seen.auth = req.headers.authorization
    seen.models.add(payload.model)
    seen.responseFormat = payload.response_format
    const sys = payload.messages?.[0]?.content ?? ''
    const user = payload.messages?.find((m) => m.role === 'user')?.content ?? ''

    let content
    if (!sys.includes('协议体检报告')) {
      seen.map++
      // 从提示里解析出真实条款，保证 quote 是原文子串（模拟一个"诚实"的模型）
      const clauseRe = /<<<(c\d+)>>>\s*([^\n]*)\n([\s\S]*?)(?=\n<<<|$)/g
      const findings = []
      let m
      const CATS = ['unilateral_change', 'account_termination', 'content_license', 'arbitration', 'data_sharing']
      while ((m = clauseRe.exec(user)) !== null) {
        const [, id, heading, raw] = m
        const text = raw.split('[本地规则预扫描提示]')[0].trim()
        if (!text) continue
        const sentence = text.split(/(?<=[。！？])/).find((s) => s.trim().length > 8) ?? text
        findings.push({
          clauseId: id,
          category: CATS[findings.length % CATS.length],
          severity: findings.length === 0 ? 'critical' : 'high',
          quote: sentence.trim().slice(0, 80),
          title: `测试发现${findings.length + 1}`,
          explanation: '这是 mock 模型给出的通俗解释。',
          impact: '这是 mock 模型给出的影响说明。',
          advice: '这是 mock 模型给出的建议。',
        })
      }
      // 混入一条"编造引文"的结论，用于验证核验层会把它丢掉
      findings.push({
        clauseId: 'c1', category: 'other', severity: 'high',
        quote: '这段文字绝对不存在于原文之中，用于测试引文核验。',
        title: '编造条目', explanation: 'x', impact: 'y', advice: 'z',
      })
      content = JSON.stringify({ findings, notes: `本批共处理 ${findings.length} 条` })
    } else {
      seen.reduce++
      content = JSON.stringify({
        riskScore: 88, verdict: '存在明显不利条款',
        summary: '这是 mock 汇总：该协议在单方变更、内容授权与争议解决方面存在明显不利于用户的安排。',
        topConcerns: [{ clauseId: 'c1', title: '单方变更', severity: 'critical', why: '可随时改协议。' }],
        categorySummary: [{ category: 'unilateral_change', severity: 'critical', count: 1, note: '可随时修改。' }],
        positives: ['条款编号清晰'],
        actions: ['定期回看协议更新'],
        readability: '表述较为清晰。',
      })
    }

    const out = JSON.stringify({
      id: 'mock', object: 'chat.completion', model: payload.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(out)
  })
})

await new Promise((r) => mock.listen(8899, r))

process.env.DEEPSEEK_API_KEY = 'test-key-123'
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:8899'
process.env.DEEPSEEK_MODEL = 'mock-flash'
process.env.DEEPSEEK_MODEL_SUMMARY = 'mock-pro'
process.env.ANALYZE_CONCURRENCY = '2'
process.env.ANALYZE_CHUNK_CHARS = '150'   // 故意切得很小，逼出多分片并发

const { analyzeDocument } = await import('../src/analyze/pipeline.js')
const { config } = await import('../src/config.js')

console.log('config:', { base: config.baseUrl, model: config.model, mock: config.mock, chunk: config.chunkChars })

const events = []
const result = await analyzeDocument({ text: AGREEMENT, title: '示例平台用户服务协议' }, {
  onEvent: (e) => { if (e.type === 'stage') events.push(`${e.stage}${e.total ? ` ${e.done}/${e.total}` : ''}`) },
})

const checks = []
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra })

ok('走的是 LLM 模式', result.stats.mode === 'llm', `mode=${result.stats.mode}`)
ok('MAP 被切分为多批并发调用', seen.map >= 2, `map=${seen.map} batches=${result.stats.batches}`)
ok('REDUCE 被调用一次', seen.reduce === 1, `reduce=${seen.reduce}`)
ok('携带 Bearer 鉴权头', seen.auth === 'Bearer test-key-123', String(seen.auth))
ok('使用了两个不同模型', seen.models.has('mock-flash') && seen.models.has('mock-pro'), [...seen.models].join(','))
ok('请求了 JSON 输出模式', seen.responseFormat?.type === 'json_object')
ok('产生了发现条目', result.findings.length > 0, `${result.findings.length} 条`)
ok('编造的引文被核验层丢弃', !result.findings.some((f) => f.quote.includes('绝对不存在')), '')
ok('所有引文都能在原文中定位', result.findings.every((f) => result.doc.text.slice(f.start, f.end).includes(f.quote.slice(0, 15))))
ok('verify 记录了丢弃数', (result.stats.verify.dropped ?? 0) >= 1, `dropped=${result.stats.verify.dropped}`)
ok('采纳了模型汇总', result.report.summary.includes('mock 汇总'))
ok('风险分被记录', Number.isFinite(result.report.riskScore), `score=${result.report.riskScore} computed=${result.report.computedScore}`)
ok('token 用量被累计', result.stats.usage.total_tokens > 0, `${result.stats.usage.total_tokens}`)
ok('类别标签可解析', result.findings.every((f) => f.category && f.category !== 'undefined'))

console.log('\n--- events ---'); console.log(events.join(' | '))
console.log('--- findings ---')
for (const f of result.findings.slice(0, 8)) console.log(` ${f.severity.padEnd(8)} ${f.category.padEnd(22)} ${f.clauseId} ${f.quote.slice(0, 40)}`)
console.log(`\ntotal findings: ${result.findings.length} | verify: ${JSON.stringify(result.stats.verify)}`)
console.log('warnings:', result.warnings)
console.log('\n--- checks ---')
let failed = 0
for (const c of checks) { if (!c.pass) failed++; console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? `  (${c.extra})` : ''}`) }
console.log(`\n${checks.length - failed}/${checks.length} passed`)

mock.close()
process.exit(failed ? 1 : 0)
