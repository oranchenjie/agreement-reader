/**
 * 集成测试：浏览器书签导入接口。
 *
 * 这个接口刻意豁免同源校验（书签必须能在任意站点上被触发），
 * 因此需要专门验证两点：
 *   1. 跨源推送确实能被接受（否则书签功能不可用）
 *   2. 豁免范围没有溢出——其它接口仍然拒绝跨源请求
 *
 * 需要服务已在 8787 端口运行：node server.js
 */
const BASE = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8787'

const SAMPLES = [
  {
    title: '哔哩哔哩隐私政策',
    url: 'https://www.bilibili.com/blackboard/privacy-pc.html',
    text: '哔哩哔哩隐私政策\n\n第一条 信息收集\n为提供服务，我们可能收集您的位置信息、设备信息、通讯录及浏览行为，并可能将上述信息共享给我们的关联方及合作伙伴用于个性化广告推荐。\n\n第二条 账号终止\n本公司有权随时单方面暂停或终止您的账号，无需事先通知，账号内余额不予退还。\n\n第三条 争议解决\n因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。\n\n第四条 内容授权\n您授予本公司全球范围内永久、不可撤销、免费、可转授权的许可。\n\n第五条 自动续费\n免费试用期结束后将自动续费并按月自动扣款。',
  },
  {
    title: '腾讯隐私政策',
    url: 'https://privacy.qq.com/policy/tencent-privacypolicy',
    text: '腾讯隐私保护政策\n\n一、我们收集的信息\n我们会收集您使用服务时的设备信息、日志信息与位置信息，用于保障服务正常运行与安全风控。\n\n二、信息共享\n我们不会向第三方出售您的个人信息。仅在法定情形或获得您同意时才会共享。\n\n三、您的权利\n您可以查询、更正、删除您的个人信息，也可以注销账号。',
  },
]

const checks = []
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra })

try {
  // ---------- 1. 跨源推送应被接受 ----------
  const push = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Origin': 'https://www.bilibili.com', 'Content-Type': 'text/plain' },
    body: JSON.stringify(SAMPLES[0]),
  })
  ok('跨源书签推送被接受（非 403）', push.status === 204, `HTTP ${push.status}`)

  // ---------- 2. 应用页面可以读到刚推送的内容 ----------
  const latest = await (await fetch(`${BASE}/api/ingest/latest`)).json()
  ok('能读回推送内容', latest.ok === true && Boolean(latest.item), `seq=${latest.seq}`)
  ok('正文长度一致', latest.item?.chars === SAMPLES[0].text.length, `${latest.item?.chars}`)
  ok('标题被保留', latest.item?.title === SAMPLES[0].title)
  ok('来源网址被保留', latest.item?.url === SAMPLES[0].url)
  ok('正文内容未损坏', latest.item?.text?.includes('个性化广告推荐'))

  // ---------- 3. 已经消费过的序号不应重复返回 ----------
  const consumed = await (await fetch(`${BASE}/api/ingest/latest?since=${latest.seq}`)).json()
  ok('since 之后无新内容时返回 null', consumed.item === null, `item=${consumed.item}`)

  // ---------- 4. 再次推送应产生新序号 ----------
  const push2 = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Origin': 'https://privacy.qq.com', 'Content-Type': 'text/plain' },
    body: JSON.stringify(SAMPLES[1]),
  })
  ok('第二次推送被接受', push2.status === 204, `HTTP ${push2.status}`)
  const latest2 = await (await fetch(`${BASE}/api/ingest/latest?since=${latest.seq}`)).json()
  ok('序号递增', latest2.seq > latest.seq, `${latest.seq} → ${latest2.seq}`)
  ok('拿到的是最新一条', latest2.item?.title === SAMPLES[1].title)

  // ---------- 5. 空内容应被拒绝 ----------
  const empty = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Origin': 'https://evil.example', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ title: 'x', text: '   ' }),
  })
  ok('空内容被拒绝', empty.status === 400, `HTTP ${empty.status}`)

  // ---------- 6. 豁免范围没有溢出：其它接口仍拒绝跨源 ----------
  for (const [path, body] of [
    ['/api/analyze', { text: '测试文本'.repeat(50), mode: 'heuristic' }],
    ['/api/fetch-url', { url: 'https://example.com' }],
    ['/api/verify-key', {}],
  ]) {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Origin': 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    ok(`${path} 仍拒绝跨源请求`, r.status === 403, `HTTP ${r.status}`)
  }

  // ---------- 7. 同源请求不受影响 ----------
  const sameOrigin = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Origin': BASE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: SAMPLES[0].text, mode: 'heuristic' }),
  })
  ok('同源分析请求正常', sameOrigin.status === 200, `HTTP ${sameOrigin.status}`)
  const analysis = await sameOrigin.json()
  ok('书签内容可被正常分析', (analysis.result?.findings?.length ?? 0) > 0, `${analysis.result?.findings?.length} 条`)
  ok('条款被正确切分', (analysis.result?.clauses?.length ?? 0) >= 4, `${analysis.result?.clauses?.length} 个条款`)
} catch (err) {
  ok('测试执行未抛异常', false, err.message)
}

console.log('--- checks ---')
let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? `  (${c.extra})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
