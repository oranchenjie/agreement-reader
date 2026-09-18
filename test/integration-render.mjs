/**
 * 集成测试：网址抓取链路（含 SPA 空壳检测与无头浏览器渲染兜底）。
 *
 * 说明：真实调用 Chrome 无法在沙箱内验证（跨工作区可执行文件被拦），
 * 因此这里用一个**假浏览器**替代 —— 它是一个可执行脚本，接受同样的参数、
 * 往 stdout 输出渲染后的 DOM。这样除「Chrome 本身」以外的全部逻辑
 * （探测、spawn、参数拼装、stdout 收集、超时、DOM 再提取、结果合并）都被真实覆盖。
 *
 * 用法：node test/integration-render.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agreement-render-'))

// ---------- 假浏览器 ----------
// 把最后一个参数当作目标 URL，并把它写进 DOM，便于断言参数确实传对了。
const FAKE_BROWSER = path.join(TMP, 'fake-browser.sh')
fs.writeFileSync(
  FAKE_BROWSER,
  `#!/bin/sh
# 忽略所有 chrome 参数，只取最后一个参数（目标 URL）
for last; do :; done
cat <<HTML
<!doctype html><html><head><title>某某平台隐私政策</title></head><body>
<div id="app">
  <h1>某某平台隐私政策</h1>
  <p>更新日期：2026 年 1 月 1 日</p>
  <h2>第一条 我们收集的信息</h2>
  <p>为提供服务，我们可能收集您的位置信息、设备信息、通讯录以及浏览行为记录，并可能将上述信息共享给我们的关联方及合作伙伴用于个性化广告推荐。</p>
  <h2>第二条 账号与终止</h2>
  <p>本公司有权随时单方面暂停或终止您的账号，且无需事先通知。账号被终止的，账户内余额不予退还。</p>
  <h2>第三条 争议解决</h2>
  <p>因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。您放弃以集体诉讼方式主张权利。</p>
  <h2>第四条 内容授权</h2>
  <p>您在本平台上传、发布的所有内容，您授予本公司全球范围内永久、不可撤销、免费、可转授权的许可，本公司有权将其用于商业用途而无需另行向您支付任何费用。</p>
  <h2>第五条 费用与自动续费</h2>
  <p>会员服务费用一经支付不予退还。免费试用期结束后将自动续费并按月自动扣款，如需取消请在到期前二十四小时操作。</p>
  <p id="rendered-from">\$last</p>
</div>
</body></html>
HTML
`,
  { mode: 0o755 },
)

// 永远不返回的假浏览器，用于验证超时
const HANGING_BROWSER = path.join(TMP, 'hanging-browser.sh')
fs.writeFileSync(HANGING_BROWSER, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })

// 必须先设置环境变量，再动态 import（config 在模块加载时读取环境）
process.env.BROWSER_BIN = FAKE_BROWSER
process.env.BROWSER_RENDER = '1'
process.env.BROWSER_TIMEOUT_MS = '15000'
process.env.MIN_USEFUL_CHARS = '300'
process.env.ALLOW_PRIVATE_URLS = '1' // 测试服务器监听在 127.0.0.1

const { extractFromUrl, normalizeUrlInput, assertPublicUrl, detectJsShell } = await import('../src/extract/index.js')
const { browserStatus, renderPage, setBrowserBinOverride } = await import('../src/extract/browser.js')

// ---------- 被测站点 ----------
const SPA_SHELL = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>某某平台隐私政策</title></head>
<body><div id="app"></div>
<noscript>We're sorry but this app doesn't work properly without JavaScript enabled. Please enable it to continue.</noscript>
<script src="/static/js/index.js"></script></body></html>`

const STATIC_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>静态协议页</title></head><body>
<nav><a href="/">首页</a><a href="/a">产品</a></nav>
<article><h1>服务条款</h1>
<h2>第一条 服务内容</h2><p>我们为您提供在线文档编辑服务，支持多人实时协作与版本管理，您可以随时导出自己的数据。</p>
<h2>第二条 联系方式</h2><p>如有任何疑问，欢迎通过客服邮箱与我们联系，我们会在三个工作日内回复您的咨询。</p>
<h2>第三条 服务变更</h2><p>我们可能会对服务内容进行调整，调整前会通过站内公告的方式提前通知您，请您留意查看。</p>
<h2>第四条 数据与隐私</h2><p>我们仅在为您提供服务所必需的范围内收集与使用您的信息，不会向无关第三方出售您的个人信息。您可以随时在设置中导出或删除自己的数据。</p>
<h2>第五条 知识产权</h2><p>您在本平台上创作的原创内容，其著作权归您所有。我们仅在为您展示和同步内容所必需的范围内使用这些内容。</p>
<h2>第六条 免责声明</h2><p>因不可抗力导致的服务中断，我们不承担责任。除此之外，我们会尽合理努力保障服务的连续性与数据安全。</p>
</article>
<footer>版权所有</footer></body></html>`

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/spa') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(SPA_SHELL)
    return
  }
  if (url.pathname === '/static') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(STATIC_PAGE)
    return
  }
  if (url.pathname === '/403') {
    res.writeHead(403, { 'Content-Type': 'text/html' })
    res.end('<html><body>Forbidden</body></html>')
    return
  }
  res.writeHead(404).end('not found')
})

await new Promise((r) => site.listen(0, '127.0.0.1', r))
const PORT = site.address().port
const base = `http://127.0.0.1:${PORT}`

const checks = []
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra })

try {
  // ---------- 1. 网址规整（用户最常见的失败原因） ----------
  ok('补全缺失的 https://', normalizeUrlInput('www.example.com/terms') === 'https://www.example.com/terms')
  ok('裸域名补全协议', normalizeUrlInput('example.com') === 'https://example.com')
  ok('已有协议头保持不变', normalizeUrlInput('http://a.com/x') === 'http://a.com/x')
  ok('归一化全角冒号与斜杠', normalizeUrlInput('example.com／a：b') === 'https://example.com/a:b')
  ok('去掉零宽字符与内部空白', normalizeUrlInput('  https://a.com/te\u200Brms  ') === 'https://a.com/terms')
  ok('空输入抛出可读错误', (() => { try { normalizeUrlInput('   '); return false } catch (e) { return /请输入网址/.test(e.message) } })())

  // ---------- 2. SPA 空壳检测 ----------
  const shell = detectJsShell(SPA_SHELL, '')
  ok('识别出 JS 空壳页面', shell.isShell === true, shell.signals.join(','))
  const notShell = detectJsShell(STATIC_PAGE, '有内容的正文')
  ok('正常内容页不被误判为空壳', notShell.isShell === false, notShell.signals.join(',') || '无信号')

  // ---------- 3. 浏览器探测 ----------
  const st = browserStatus()
  ok('探测到 BROWSER_BIN 指定的浏览器', st.available === true, st.bin)

  // ---------- 4. 静态页面：不应触发渲染 ----------
  const staticRes = await extractFromUrl(`${base}/static`)
  ok('静态页抓取成功', staticRes.sufficient === true, `${staticRes.text.length} 字`)
  ok('静态页未使用浏览器渲染', staticRes.meta.renderedWithBrowser === false)
  ok('静态页正确剔除导航与页脚', !staticRes.text.includes('首页') && !staticRes.text.includes('版权所有'))
  ok('静态页保留条款正文', staticRes.text.includes('在线文档编辑服务'))

  // ---------- 5. SPA 页面：应回退到浏览器渲染并拿到正文 ----------
  const spaRes = await extractFromUrl(`${base}/spa`)
  ok('SPA 页面最终判定为内容充足', spaRes.sufficient === true, `${spaRes.text.length} 字`)
  ok('SPA 页面标记为使用了浏览器渲染', spaRes.meta.renderedWithBrowser === true)
  ok('拿到了 JS 渲染后才有的正文', spaRes.text.includes('个性化广告推荐'))
  ok('正文覆盖多个条款', spaRes.text.includes('仲裁') && spaRes.text.includes('余额不予退还'))
  ok('提示中说明了发生了渲染兜底', (spaRes.meta.warnings ?? []).some((w) => w.includes('用本机浏览器渲染')))
  ok('目标 URL 被正确传给了浏览器', spaRes.text.includes(`${base}/spa`))

  // ---------- 6. 浏览器不可用 / 渲染失败时的降级 ----------
  setBrowserBinOverride(path.join(TMP, 'does-not-exist'))
  const badStatus = browserStatus()
  ok('浏览器路径无效时报告不可用', badStatus.available === false && /不可执行/.test(badStatus.reason ?? ''), badStatus.reason)
  const degraded = await extractFromUrl(`${base}/spa`)
  ok('浏览器不可用时仍返回结果而非报错', degraded.sufficient === false && typeof degraded.text === 'string')
  ok('降级时提示浏览器不可用并给出替代方案', (degraded.meta.warnings ?? []).some((w) => w.includes('未在本机找到') || w.includes('粘贴')))

  // ---------- 7. 渲染超时 ----------
  setBrowserBinOverride(HANGING_BROWSER)
  const t0 = Date.now()
  let timeoutErr = null
  try {
    await renderPage('http://example.com', { timeoutMs: 2500 })
  } catch (err) {
    timeoutErr = err
  }
  const elapsed = Date.now() - t0
  ok('渲染超时会被中止', Boolean(timeoutErr), timeoutErr?.message?.slice(0, 40))
  ok('超时后及时返回（未挂死）', elapsed < 12000, `${elapsed}ms`)

  // ---------- 8. HTTP 错误信息可读 ----------
  setBrowserBinOverride(FAKE_BROWSER)
  let httpErr = null
  try {
    await extractFromUrl(`${base}/403`)
  } catch (err) {
    httpErr = err
  }
  ok('403 给出可操作的中文提示', /403/.test(httpErr?.message ?? '') && /粘贴/.test(httpErr?.message ?? ''), httpErr?.message)

  let dnsErr = null
  try {
    await extractFromUrl('https://this-domain-should-not-exist-abc123xyz.invalid/terms')
  } catch (err) {
    dnsErr = err
  }
  ok('域名解析失败给出可读提示', /解析失败|抓取失败/.test(dnsErr?.message ?? ''), dnsErr?.message)

  // ---------- 9. 内网地址在默认配置下应被拒绝 ----------
  // config 在模块加载时冻结，无法在本进程内切换开关，
  // 因此这里用子进程以默认配置验证（ALLOW_PRIVATE_URLS 未设置 → 应为拒绝）。
  const { execFileSync } = await import('node:child_process')
  const probe = `import('./src/extract/index.js').then(m => {
    try { m.assertPublicUrl('http://127.0.0.1:8080/x'); console.log('ALLOWED') }
    catch (e) { console.log('BLOCKED:' + (e.code || 'no-code')) }
  })`
  const out = execFileSync(process.execPath, ['-e', probe], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, ALLOW_PRIVATE_URLS: '' },
    encoding: 'utf8',
  }).trim()
  ok('默认配置下内网地址被拒绝', out === 'BLOCKED:PRIVATE_URL', out)
} finally {
  site.close()
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log('--- checks ---')
let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? `  (${c.extra})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
