/**
 * 集成测试：用户在网页里自带 API Key 的完整链路。
 *
 * 场景：应用服务端**完全没有**配置密钥（模拟"用户自己填"的真实情况），
 * 请求头携带密钥 → 应该走真实模型；不携带 → 应该拒绝或降级为本地规则。
 *
 * 同时验证若干安全性质：密钥不出现在任何响应体、跨站请求被拒绝。
 *
 * 用法：node test/integration-userkey.mjs
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = 8788
const MOCK_PORT = 8899
const FAKE_KEY = 'sk-test-user-supplied-key-1234567890'

const AGREEMENT = `示例平台用户服务协议

第一条 协议的接受与变更
本公司有权随时单方面修改本协议，且无需另行通知您。

第二条 账号与终止
本公司有权随时暂停或终止您的账号。账户内余额不予退还。

第三条 争议解决
因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。
`

// ---------- mock LLM（OpenAI 兼容） ----------
const seen = { chat: 0, models: 0, lastAuth: null }

const mockLlm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url.startsWith('/models')) {
      seen.models++
      seen.lastAuth = req.headers.authorization
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }))
      return
    }

    if (req.url.startsWith('/chat/completions')) {
      seen.chat++
      seen.lastAuth = req.headers.authorization
      const payload = JSON.parse(body || '{}')
      const sys = payload.messages?.[0]?.content ?? ''
      const user = payload.messages?.find((m) => m.role === 'user')?.content ?? ''
      let content

      if (!sys.includes('协议体检报告')) {
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
        content = JSON.stringify({ findings })
      } else {
        content = JSON.stringify({
          riskScore: 70,
          verdict: '模型结论：存在明显不利条款',
          summary: '这是由 mock 真实模型链路生成的汇总摘要。',
          topConcerns: [],
          categorySummary: [],
          positives: [],
          actions: ['留意协议变更'],
          readability: '一般。',
        })
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
        }),
      )
      return
    }

    res.writeHead(404).end('{}')
  })
})

await new Promise((r) => mockLlm.listen(MOCK_PORT, r))

// ---------- 启动应用服务端（故意不配任何密钥） ----------
// DSH_IGNORE_DOTENV=1 确保本机 .env 里的配置不会影响本测试的判定
const app = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_IGNORE_DOTENV: '1',
    PORT: String(APP_PORT),
    DSH_AGREEMENT_MOCK: '0',
    DEEPSEEK_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

const BASE = `http://127.0.0.1:${APP_PORT}`

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

const checks = []
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra })

try {
  if (!(await waitForServer())) {
    console.error('应用服务端启动失败：\n' + appLog)
    process.exit(1)
  }

  const keyHeaders = {
    'Content-Type': 'application/json',
    'X-DeepSeek-Key': encodeURIComponent(FAKE_KEY),
    'X-DeepSeek-Base-Url': encodeURIComponent(`http://127.0.0.1:${MOCK_PORT}`),
    'X-DeepSeek-Model': 'deepseek-v4-flash',
  }

  // ---- 0. 确认服务端自身没有密钥 ----
  const cfgRes = await (await fetch(`${BASE}/api/config`)).json()
  ok('服务端未配置任何密钥（模拟用户自带）', cfgRes.config.hasApiKey === false, `hasApiKey=${cfgRes.config.hasApiKey}`)

  // ---- 1. 没带密钥 + 强制模型 → 应被明确拒绝 ----
  const noKey = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: AGREEMENT, mode: 'llm' }),
  })
  const noKeyBody = await noKey.json()
  ok('无密钥强制模型分析被拒绝', noKey.status === 400 && noKeyBody.code === 'NO_API_KEY', `HTTP ${noKey.status} ${noKeyBody.code}`)

  // ---- 2. 没带密钥 + 自动 → 降级为本地规则，仍然出结果 ----
  const autoNoKey = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: AGREEMENT, mode: 'auto' }),
  })
  const autoBody = await autoNoKey.json()
  ok('无密钥自动模式降级为本地规则', autoBody.result?.stats.mode === 'heuristic', autoBody.result?.stats.mode)
  ok('降级时明确告知用户', (autoBody.result?.warnings ?? []).some((w) => w.includes('未检测到 API Key')))

  // ---- 3. 带密钥 → 应走真实模型 ----
  const withKey = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: keyHeaders,
    body: JSON.stringify({ text: AGREEMENT, mode: 'llm' }),
  })
  const withKeyBody = await withKey.json()
  ok('带密钥的分析成功', withKey.status === 200 && withKeyBody.ok === true, `HTTP ${withKey.status}`)
  ok('确实走了模型模式', withKeyBody.result?.stats.mode === 'llm', withKeyBody.result?.stats.mode)
  ok('密钥来源标记为 request', withKeyBody.result?.stats.keySource === 'request', withKeyBody.result?.stats.keySource)
  ok('模型确实被调用', seen.chat > 0, `chat 调用 ${seen.chat} 次`)
  ok('鉴权头透传了用户密钥', seen.lastAuth === `Bearer ${FAKE_KEY}`, String(seen.lastAuth).slice(0, 24) + '…')
  ok('采纳了模型的汇总结果', String(withKeyBody.result?.report.summary ?? '').includes('mock 真实模型链路'))
  ok('产出风险条款', (withKeyBody.result?.findings.length ?? 0) > 0, `${withKeyBody.result?.findings?.length} 条`)

  // ---- 4. 密钥绝不能出现在响应体里 ----
  const serialized = JSON.stringify(withKeyBody)
  ok('响应体中不含密钥明文', !serialized.includes(FAKE_KEY))
  ok('响应体中不含密钥片段', !serialized.includes(FAKE_KEY.slice(0, 16)))

  // ---- 5. 测试连接接口 ----
  const verify = await fetch(`${BASE}/api/verify-key`, { method: 'POST', headers: keyHeaders, body: '{}' })
  const verifyBody = await verify.json()
  ok('测试连接成功', verify.status === 200 && verifyBody.valid === true, `HTTP ${verify.status}`)
  ok('返回可见模型列表', (verifyBody.models ?? []).includes('deepseek-v4-flash'), (verifyBody.models ?? []).join(','))
  ok('只回显密钥末四位', verifyBody.keyHint === `…${FAKE_KEY.slice(-4)}`, String(verifyBody.keyHint))

  const badVerify = await fetch(`${BASE}/api/verify-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DeepSeek-Key': 'sk-wrong' },
    body: '{}',
  })
  ok('错误密钥的测试连接会失败（而非假成功）', badVerify.status >= 400, `HTTP ${badVerify.status}`)

  // ---- 6. 凭据也可以走请求体（兼容请求头被剥离的场景） ----
  const viaBody = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: AGREEMENT,
      mode: 'llm',
      apiKey: FAKE_KEY,
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
    }),
  })
  const viaBodyJson = await viaBody.json()
  ok('凭据走请求体同样生效', viaBodyJson.result?.stats.mode === 'llm', viaBodyJson.result?.stats.mode)

  // ---- 7. 跨站请求防护 ----
  const crossOrigin = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' },
    body: JSON.stringify({ text: AGREEMENT, mode: 'auto' }),
  })
  ok('跨站 Origin 被拒绝（防 CSRF）', crossOrigin.status === 403, `HTTP ${crossOrigin.status}`)

  const sameOrigin = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ text: AGREEMENT, mode: 'auto' }),
  })
  ok('同源 Origin 正常放行', sameOrigin.status === 200, `HTTP ${sameOrigin.status}`)

  // ---- 8. 服务端日志里不应出现密钥 ----
  await new Promise((r) => setTimeout(r, 300))
  ok('服务端日志不含密钥', !appLog.includes(FAKE_KEY) && !appLog.includes(FAKE_KEY.slice(0, 16)))
} finally {
  app.kill('SIGTERM')
  mockLlm.close()
}

console.log('--- checks ---')
let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? `  (${c.extra})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
