import zlib from 'node:zlib'

// ---- 最小 ZIP/DOCX 生成器（用于验证 docx 提取链路）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c }
  return t
})()
function crc32(buf) { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }

function makeZip(files) {
  const locals = [], centrals = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const comp = zlib.deflateRawSync(data)
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    locals.push(lh, nameBuf, comp)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42)
    centrals.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + comp.length
  }
  const localBuf = Buffer.concat(locals), cenBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16)
  return Buffer.concat([localBuf, cenBuf, eocd])
}

const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>某某云服务用户协议</w:t></w:r></w:p>
<w:p><w:r><w:t>第一条 服务内容</w:t></w:r></w:p>
<w:p><w:r><w:t>本公司有权随时单方面修改本协议，且无需另行通知您。</w:t></w:r></w:p>
<w:p><w:r><w:t>第二条 自动续费</w:t></w:r></w:p>
<w:p><w:r><w:t>免费试用期结束后将自动续费并按月自动扣款。</w:t></w:r></w:p>
<w:p><w:numPr/><w:r><w:t>您授予本公司永久、不可撤销、免费、可转授权的许可。</w:t></w:r></w:p>
</w:body></w:document>`

const docx = makeZip([
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>', 'utf8') },
  { name: 'word/document.xml', data: Buffer.from(docXml, 'utf8') },
])

const html = `<!doctype html><html><head><title>示例网站服务条款</title></head><body>
<nav class="site-nav"><a href="/">首页</a><a href="/a">产品</a><a href="/b">价格</a><a href="/c">关于</a></nav>
<div class="cookie-banner">本站使用 Cookie，继续浏览表示同意。<button>接受</button></div>
<main><article class="terms-content">
<h1>服务条款</h1>
<h2>第一条 服务内容</h2><p>本公司有权随时单方面修改本协议，且无需另行通知您。</p>
<h2>第二条 隐私与数据</h2><p>我们可能将您的个人信息共享给我们的关联方及合作伙伴用于个性化广告推荐。</p>
<h2>第三条 争议解决</h2><p>因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。</p>
</article></main>
<aside class="related"><a href="/x">相关阅读一</a><a href="/y">相关阅读二</a></aside>
<footer class="site-footer">版权所有 © 示例公司 | 京ICP备00000000号</footer>
</body></html>`

const base = 'http://127.0.0.1:8787'

async function upload(name, buf, mime) {
  const res = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(name) },
    body: buf,
  })
  return { status: res.status, body: await res.json() }
}

for (const [name, buf, mime] of [
  ['服务条款.html', Buffer.from(html, 'utf8'), 'text/html'],
  ['用户协议.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['协议.txt', Buffer.from('第一条 测试\n本公司有权随时修改本协议。', 'utf8'), 'text/plain'],
]) {
  const { status, body } = await upload(name, buf, mime)
  console.log(`\n=== ${name} → HTTP ${status} | 格式: ${body.meta?.format} | 提取器: ${body.meta?.extractor} | ${body.text?.length ?? 0} 字 ===`)
  if (body.meta?.warnings?.length) console.log('warnings:', body.meta.warnings)
  console.log('title:', JSON.stringify(body.title))
  console.log('--- text ---')
  console.log((body.text ?? '').slice(0, 420))
  if (body.meta?.format === 'html') {
    const t = body.text ?? ''
    console.log('--- 噪声检查 ---')
    console.log('含导航:', t.includes('首页'), '| 含Cookie横幅:', t.includes('继续浏览'), '| 含相关阅读:', t.includes('相关阅读'), '| 含页脚版权:', t.includes('京ICP'))
  }
}
