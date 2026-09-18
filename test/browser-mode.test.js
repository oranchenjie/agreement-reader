/**
 * 「浏览器模式」兼容性测试。
 *
 * 纯静态站点（GitHub Pages）要能在浏览器里直接解析 PDF/Word，靠的是自研垫片
 * （把全局 `Buffer` 换成 `ShimBuffer`）。这是整个移植里风险最高的一环 ——
 * 2200 行的 PDF 解析器全程依赖 Buffer，一个方法语义不对就会解析出乱码。
 *
 * 这个文件做的事：**把全局 Buffer 换成垫片，然后跑真实的解析代码**，
 * 尽可能逼近浏览器里的执行条件。
 *
 * 注意：Node 的测试运行器为每个文件开独立进程，所以这里改全局不会污染其它测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlibNode from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ShimBuffer, inflateSync, inflateRawSync } from '../public/js/browser-shim.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RealBuffer = globalThis.Buffer

// ============================================================
// 垫片的 inflate：拿 node:zlib 当参照物
// ============================================================

/** 固定种子的伪随机，保证用例可复现 */
function pseudoRandom(n, seed = 12345) {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

const INFLATE_CASES = [
  ['空数据', RealBuffer.alloc(0)],
  ['单字节', RealBuffer.from([0x41])],
  ['纯 ASCII', RealBuffer.from('the quick brown fox jumps over the lazy dog')],
  ['中文 UTF-8', RealBuffer.from('用户协议与隐私政策，平台有权随时修改。'.repeat(20))],
  ['随机二进制', RealBuffer.from(pseudoRandom(5000))],
  ['高压缩比', RealBuffer.from('A'.repeat(100000))],
]

for (const [name, buf] of INFLATE_CASES) {
  for (const level of [0, 1, 6, 9]) {
    test(`inflateSync: ${name}（level ${level}）`, () => {
      const compressed = zlibNode.deflateSync(buf, { level })
      const got = RealBuffer.from(inflateSync(new Uint8Array(compressed)))
      assert.equal(RealBuffer.compare(got, buf), 0, '解压结果必须与原数据逐字节相同')
    })
  }
  test(`inflateRawSync: ${name}`, () => {
    const compressed = zlibNode.deflateRawSync(buf)
    const got = RealBuffer.from(inflateRawSync(new Uint8Array(compressed)))
    assert.equal(RealBuffer.compare(got, buf), 0)
  })
}

test('inflateSync: 大文件（约 2MB）不应栈溢出且耗时可控', () => {
  const big = RealBuffer.from('这是一段会被反复引用的协议正文。'.repeat(40000))
  const t0 = Date.now()
  const got = RealBuffer.from(inflateSync(new Uint8Array(zlibNode.deflateSync(big))))
  const ms = Date.now() - t0
  assert.equal(RealBuffer.compare(got, big), 0)
  assert.ok(ms < 5000, `耗时 ${ms}ms 过长`)
})

test('inflateSync: 固定 Huffman 策略（BTYPE=1）', () => {
  const buf = RealBuffer.from('abcabcabc'.repeat(500))
  const z = zlibNode.deflateSync(buf, { strategy: zlibNode.constants.Z_FIXED })
  assert.equal(RealBuffer.from(inflateSync(new Uint8Array(z))).toString(), buf.toString())
})

test('inflateSync: 损坏数据必须抛错，不能静默返回残缺内容', () => {
  const z = zlibNode.deflateSync(RealBuffer.from('协议正文'.repeat(50)))
  const cases = {
    截断: new Uint8Array(z.subarray(0, Math.floor(z.length / 2))),
    头损坏: (() => { const c = Uint8Array.from(z); c[0] = 0xff; return c })(),
    校验和错误: (() => { const c = Uint8Array.from(z); c[c.length - 1] ^= 0xff; return c })(),
  }
  for (const [label, bad] of Object.entries(cases)) {
    assert.throws(() => inflateSync(bad), `「${label}」应当抛错`)
  }
})

// ============================================================
// Buffer 兼容性：与 Node Buffer 逐一对拍
// ============================================================

test('ShimBuffer: 编码往返与 Node Buffer 一致', () => {
  const text = '中文abc123'
  assert.equal(ShimBuffer.from(text, 'utf8').toString('utf8'), RealBuffer.from(text, 'utf8').toString('utf8'))
  assert.equal(ShimBuffer.from('deadbeef00ff', 'hex').toString('hex'), RealBuffer.from('deadbeef00ff', 'hex').toString('hex'))
  assert.equal(ShimBuffer.from('5L2g5aW9', 'base64').toString('utf8'), RealBuffer.from('5L2g5aW9', 'base64').toString('utf8'))
  assert.equal(
    ShimBuffer.from([0x80, 0xff, 0x41], 'latin1').toString('latin1'),
    RealBuffer.from([0x80, 0xff, 0x41], 'latin1').toString('latin1'),
  )
})

test('ShimBuffer: 各 readUInt 与 Node 一致', () => {
  const bytes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]
  const n = RealBuffer.from(bytes)
  const s = ShimBuffer.from(bytes)
  assert.equal(s.readUInt8(0), n.readUInt8(0))
  assert.equal(s.readUInt16LE(0), n.readUInt16LE(0))
  assert.equal(s.readUInt32LE(0), n.readUInt32LE(0))
  assert.equal(s.readBigUInt64LE(0), n.readBigUInt64LE(0))
})

test('ShimBuffer: indexOf / includes / slice / alloc / concat 与 Node 一致', () => {
  const n = RealBuffer.from([1, 2, 3, 4, 5, 6])
  const s = ShimBuffer.from([1, 2, 3, 4, 5, 6])
  assert.equal(s.indexOf(3), n.indexOf(3))
  assert.equal(s.indexOf(ShimBuffer.from([3, 4])), n.indexOf(RealBuffer.from([3, 4])))
  assert.equal(s.includes(ShimBuffer.from([5, 6])), n.includes(RealBuffer.from([5, 6])))
  assert.deepEqual([...ShimBuffer.alloc(4)], [0, 0, 0, 0])
  assert.equal(ShimBuffer.concat([ShimBuffer.from([1, 2]), ShimBuffer.from([3])]).length, 3)
})

test('ShimBuffer: slice 是共享内存的视图（PDF 解析器依赖这一点）', () => {
  const s = ShimBuffer.from([1, 2, 3, 4])
  const view = s.slice(1, 3)
  view[0] = 0x99
  assert.equal(s[1], 0x99, 'slice 必须是视图而不是拷贝，否则解析器会读到旧数据')
})

test('ShimBuffer: 越界读取抛错（不能静默返回 undefined）', () => {
  const s = ShimBuffer.from([1, 2, 3, 4])
  assert.throws(() => s.readUInt32LE(100))
})

// ============================================================
// 【核心】把全局 Buffer 换成垫片，跑真实解析代码
// ============================================================

/** 造一个带 FlateDecode 压缩内容流的真实 PDF */
function makePdf(lines) {
  const content = ['BT', '/F1 12 Tf', '72 720 Td', '16 TL']
  for (const l of lines) content.push(`(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`)
  content.push('ET')
  const comp = zlibNode.deflateSync(RealBuffer.from(content.join('\n'), 'latin1'))

  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  const chunks = [RealBuffer.from('%PDF-1.4\n', 'latin1')]
  const offsets = [0]
  let pos = chunks[0].length
  for (let i = 1; i <= 5; i++) {
    if (i === 4) {
      const head = RealBuffer.from(`4 0 obj\n<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`, 'latin1')
      const tail = RealBuffer.from('\nendstream\nendobj\n', 'latin1')
      offsets[i] = pos
      chunks.push(head, comp, tail)
      pos += head.length + comp.length + tail.length
      continue
    }
    const buf = RealBuffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`, 'latin1')
    offsets[i] = pos
    chunks.push(buf)
    pos += buf.length
  }
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  chunks.push(RealBuffer.from(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'))
  return RealBuffer.concat(chunks)
}

/** 造一个 ZIP（DOCX 本质就是 ZIP） */
function makeZip(files) {
  const CRC = (() => {
    const t = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[i] = c
    }
    return t
  })()
  const crc32 = (b) => {
    let c = -1
    for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }

  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = RealBuffer.from(name, 'utf8')
    const comp = zlibNode.deflateRawSync(data)
    const crc = crc32(data)
    const lh = RealBuffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    locals.push(lh, nameBuf, comp)

    const ch = RealBuffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + comp.length
  }
  const lb = RealBuffer.concat(locals)
  const cb = RealBuffer.concat(centrals)
  const eocd = RealBuffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cb.length, 12)
  eocd.writeUInt32LE(lb.length, 16)
  return RealBuffer.concat([lb, cb, eocd])
}

test('【核心】真实 PDF 解析在垫片 Buffer 下正常工作', async () => {
  const pdf = makePdf([
    'Terms of Service',
    'The Company may modify this agreement at any time without notice.',
    'We may share your personal information with our affiliates and partners.',
  ])

  globalThis.Buffer = ShimBuffer
  try {
    const { extractPdfText } = await import('../src/extract/pdf.js')
    const r = await extractPdfText(ShimBuffer.from(new Uint8Array(pdf)))
    assert.ok(r.text.length > 0, '应提取到文本')
    assert.match(r.text, /modify this agreement/, '正文内容必须正确，不能是乱码')
    assert.equal(r.meta.pageCount, 1)
  } finally {
    globalThis.Buffer = RealBuffer
  }
})

test('【核心】真实 DOCX 解析在垫片 Buffer 下正常工作（含中文）', async () => {
  const docXml =
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    '<w:p><w:r><w:t>用户协议</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>本公司有权随时修改本协议。</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  const docx = makeZip([
    { name: '[Content_Types].xml', data: RealBuffer.from('<?xml version="1.0"?><Types/>', 'utf8') },
    { name: 'word/document.xml', data: RealBuffer.from(docXml, 'utf8') },
  ])

  globalThis.Buffer = ShimBuffer
  try {
    const { extractDocxText } = await import('../src/extract/docx.js')
    const r = extractDocxText(ShimBuffer.from(new Uint8Array(docx)))
    assert.ok(r.text.includes('本公司有权随时修改本协议'), `中文必须正确还原：${JSON.stringify(r.text.slice(0, 40))}`)
  } finally {
    globalThis.Buffer = RealBuffer
  }
})

// ============================================================
// 共享逻辑不能有 Node 专有的静态 import
// ============================================================

test('【核心】分析逻辑里不能有 node: 静态导入（否则浏览器加载即失败）', () => {
  const shared = [
    'src/analyze/pipeline.js',
    'src/analyze/ask.js',
    'src/analyze/retrieve.js',
    'src/analyze/verify.js',
    'src/analyze/prompts.js',
    'src/analyze/json.js',
    'src/analyze/taxonomy.js',
    'src/analyze/heuristic.js',
    'src/analyze/client.js',
    'src/analyze/websearch.js',
    'src/normalize.js',
    'src/segment.js',
    'src/ids.js',
    'src/config.js',
    'src/extract/html.js',
    'src/extract/pdf.js',
    'src/extract/zip.js',
    'src/extract/docx.js',
    'src/extract/index.js',
    'src/extract/zlib-compat.js',
  ]

  const offenders = []
  for (const rel of shared) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const m of src.matchAll(/^import\s[^\n]*from\s*['"](node:[^'"]+)['"]/gm)) {
      offenders.push(`${rel} → ${m[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `这些静态导入会让模块在浏览器里加载失败：\n${offenders.join('\n')}`)
})

test('【核心】服务端专属模块必须用动态 import（不能静态引入）', () => {
  // config.node.js 与 browser.js 依赖 node:fs / node:child_process，
  // 只能被"按需动态 import"，绝不能出现在静态 import 链上
  const configSrc = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8')
  assert.ok(!/^import\s[^\n]*config\.node\.js/m.test(configSrc), 'config.node.js 必须动态导入')

  const extractSrc = fs.readFileSync(path.join(ROOT, 'src/extract/index.js'), 'utf8')
  assert.ok(!/^import\s[^\n]*browser\.js/m.test(extractSrc), 'browser.js 必须动态导入')
})
