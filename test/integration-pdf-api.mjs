import zlib from 'node:zlib'

/** 生成一个最小但合法的 PDF（FlateDecode 压缩内容流 + WinAnsi 字体） */
function makePdf(lines) {
  const content = ['BT', '/F1 12 Tf', '72 720 Td', '16 TL']
  for (const l of lines) content.push(`(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`)
  content.push('ET')
  const raw = Buffer.from(content.join('\n'), 'latin1')
  const comp = zlib.deflateSync(raw)

  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets = [0]
  let pos = chunks[0].length
  for (let i = 1; i <= 5; i++) {
    if (i === 4) {
      const head = Buffer.from(`4 0 obj\n<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`, 'latin1')
      const tail = Buffer.from('\nendstream\nendobj\n', 'latin1')
      offsets[i] = pos
      chunks.push(head, comp, tail)
      pos += head.length + comp.length + tail.length
      continue
    }
    const buf = Buffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`, 'latin1')
    offsets[i] = pos
    chunks.push(buf)
    pos += buf.length
  }
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  const startxref = pos
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(chunks)
}

const pdf = makePdf([
  'Terms of Service - Example Platform',
  '',
  'Article 1. Acceptance',
  'The Company may modify this agreement at any time without notice.',
  'Continued use constitutes acceptance of the revised terms.',
  '',
  'Article 2. Data Sharing',
  'We may share your personal information with our affiliates and partners.',
  '',
  'Article 3. Dispute Resolution',
  'All disputes shall be submitted to binding arbitration.',
])

console.log('PDF bytes:', pdf.length, '| magic:', pdf.toString('latin1', 0, 5))

const res = await fetch('http://127.0.0.1:8787/api/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent('terms.pdf') },
  body: pdf,
})
const body = await res.json()
console.log('HTTP', res.status, '| format:', body.meta?.format, '| extractor:', body.meta?.extractor)
console.log('pages:', JSON.stringify(body.meta?.details), '| warnings:', body.meta?.warnings)
console.log('--- 提取文本 ---')
console.log(body.text)

// 直接把提取出的文本送去分析，验证"PDF → 分析"完整链路
const res2 = await fetch('http://127.0.0.1:8787/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: body.text, title: 'Example Platform ToS', mode: 'heuristic' }),
})
const body2 = await res2.json()
console.log('\n--- 分析结果 ---')
console.log('HTTP', res2.status, '| clauses:', body2.result?.clauses.length, '| findings:', body2.result?.findings.length, '| score:', body2.result?.report.riskScore)
for (const f of body2.result?.findings ?? []) console.log(` ${f.severity.padEnd(8)} ${f.category.padEnd(26)} ${f.quote.slice(0, 60)}`)
