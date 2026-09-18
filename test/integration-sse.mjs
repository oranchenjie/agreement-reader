const text = `示例平台用户服务协议

第一条 协议的接受与变更
欢迎使用示例平台。本公司有权随时单方面修改本协议，且无需另行通知您。您继续使用本服务即视为接受修改后的协议。

第二条 账号与终止
本公司有权随时暂停或终止您的账号，无需事先通知。账号被终止的，账户内余额不予退还。

第三条 内容授权
您在本平台上传、发布的所有内容，您授予本公司全球范围内永久、不可撤销、免费、可转授权的许可。

第四条 隐私与数据
我们可能收集您的位置信息、设备信息、通讯录及浏览行为，并可能将上述信息共享给我们的关联方及合作伙伴用于个性化广告推荐。

第五条 费用与自动续费
会员服务费用一经支付不予退还。免费试用期结束后将自动续费并按月自动扣款。

第六条 争议解决
因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。您放弃以集体诉讼方式主张权利。
`

const res = await fetch('http://127.0.0.1:8787/api/analyze/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, title: '示例平台用户服务协议', mode: 'heuristic' }),
})

console.log('HTTP', res.status, res.headers.get('content-type'))

const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = ''
let result = null
const stages = []

for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue
      const ev = JSON.parse(line.slice(5).trim())
      if (ev.type === 'stage') stages.push(`${ev.stage}: ${ev.message}${ev.total ? ` [${ev.done}/${ev.total}]` : ''}`)
      if (ev.type === 'result') result = ev.result
      if (ev.type === 'error') console.log('ERROR EVENT:', ev)
    }
  }
}

console.log('--- SSE stages ---'); console.log(stages.join('\n'))
console.log('--- result ---')
console.log('clauses:', result.clauses.length, '| findings:', result.findings.length, '| score:', result.report.riskScore)
console.log('categories in report:', result.report.categorySummary.length)
console.log('topConcerns:', result.report.topConcerns.length)
console.log('actions:', result.report.actions.length)
const bad = result.findings.filter(f => !(f.start >= 0 && f.end > f.start && f.end <= result.doc.text.length))
console.log('offsets out of range:', bad.length)
// 验证高亮切片真的等于引文
let mismatch = 0
for (const f of result.findings) {
  const slice = result.doc.text.slice(f.start, f.end)
  if (!slice.includes(f.quote.slice(0, 20))) mismatch++
}
console.log('quote/offset mismatches:', mismatch)
