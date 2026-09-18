/**
 * 报告导出。
 *
 * 导出 Markdown 而不是直接生成 PDF：Markdown 便于留存、diff 与二次加工，
 * 需要 PDF 时用浏览器的「打印 / 存为 PDF」即可（样式已做打印适配）。
 */
import { formatDate, formatDuration, formatNumber } from './util.js'

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

/**
 * @param {object} result 分析结果
 * @param {{categories:Array, severityLabels:Record<string,string>}} taxonomy
 * @returns {string} Markdown 文本
 */
export function toMarkdown(result, taxonomy) {
  const categoryLabel = (id) => taxonomy?.categories?.find((c) => c.id === id)?.label ?? id
  const severityLabel = (s) => taxonomy?.severityLabels?.[s] ?? s

  const doc = result.doc ?? {}
  const report = result.report ?? {}
  const stats = result.stats ?? {}
  const findings = result.findings ?? []

  const lines = []
  const push = (...xs) => lines.push(...xs)

  push(`# 协议风险报告：${doc.title || '未命名协议'}`, '')
  push(
    `> 生成时间：${formatDate(result.createdAt)}　|　分析模式：${
      stats.mode === 'heuristic' ? '本地规则（未调用模型）' : `模型分析（${stats.model ?? '—'}）`
    }　|　协议规模：${formatNumber(doc.chars)} 字 / ${formatNumber(doc.clauseCount)} 个条款`,
    '',
  )

  push('## 一、整体评估', '')
  push(`**风险分：${report.riskScore ?? '—'} / 100　—　${report.verdict ?? ''}**`, '')
  if (report.summary) push(report.summary, '')
  if (report.readability) push(`*可读性与透明度：${report.readability}*`, '')

  const counts = {}
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
  const countLine = SEVERITY_ORDER.filter((s) => counts[s])
    .map((s) => `${severityLabel(s)} ${counts[s]}`)
    .join('　')
  if (countLine) push(`风险条目分布：${countLine}`, '')

  if ((report.topConcerns ?? []).length) {
    push('## 二、最需要关注的几条', '')
    report.topConcerns.forEach((c, i) => {
      push(`${i + 1}. **[${severityLabel(c.severity)}] ${c.title}**${c.clauseId ? `　\`${c.clauseId}\`` : ''}`)
      if (c.why) push(`   - ${c.why}`)
    })
    push('')
  }

  if ((report.categorySummary ?? []).length) {
    push('## 三、问题分布', '')
    push('| 风险类别 | 最高等级 | 条目数 | 说明 |', '| --- | --- | --- | --- |')
    for (const c of report.categorySummary) {
      push(`| ${categoryLabel(c.category)} | ${severityLabel(c.severity)} | ${c.count || ''} | ${c.note || ''} |`)
    }
    push('')
  }

  if ((report.actions ?? []).length) {
    push('## 四、建议采取的行动', '')
    for (const a of report.actions) push(`- [ ] ${a}`)
    push('')
  }

  if ((report.positives ?? []).length) {
    push('## 五、相对合理的地方', '')
    for (const p of report.positives) push(`- ${p}`)
    push('')
  }

  push('## 六、风险条款清单', '')
  if (findings.length === 0) {
    push('本次分析未发现明显的风险条款。', '')
  } else {
    findings.forEach((f, i) => {
      push(`### ${i + 1}. [${severityLabel(f.severity)}] ${f.title}　\`${categoryLabel(f.category)}\``, '')
      push(`> ${f.quote}`, '')
      push(`- **出自**：${f.clauseHeading || f.clauseId}${f.crossClause ? '（跨条款引用）' : ''}`)
      if (f.explanation) push(`- **含义**：${f.explanation}`)
      if (f.impact) push(`- **影响**：${f.impact}`)
      if (f.advice) push(`- **建议**：${f.advice}`)
      push('')
    })
  }

  push('## 附：分析说明', '')
  push(`- 条款切分方式：${doc.segmentStrategy === 'structure' ? '按协议编号结构' : '按段落聚合'}`)
  push(
    `- 引文核验：${stats.verify?.kept ?? 0} 条通过原文核验${
      stats.verify?.dropped ? `，${stats.verify.dropped} 条因无法定位到原文被丢弃` : ''
    }`,
  )
  if (stats.verify?.fuzzy) push(`- 其中 ${stats.verify.fuzzy} 条为容错匹配（存在空格或标点差异）`)
  push(`- 本地规则预扫描命中：${formatNumber(stats.prescanHits)} 处`)
  push(`- 分析耗时：${formatDuration(stats.ms)}`)
  if (stats.usage?.total_tokens) push(`- Token 用量：${formatNumber(stats.usage.total_tokens)}`)
  push('')

  const warnings = [...new Set([...(result.extraction?.warnings ?? []), ...(result.warnings ?? [])])]
  if (warnings.length) {
    push('### 本次分析的已知限制', '')
    for (const w of warnings) push(`- ${w}`)
    push('')
  }

  push('---', '')
  push('本报告由「协议阅读器」自动生成，内容由 AI 归纳，仅供风险提示，**不构成法律意见**。')
  push('涉及重大权益的决策，请咨询专业律师。所有结论都标注了原文出处，建议逐条核对。')

  return lines.join('\n')
}

/** 触发浏览器下载 */
export function downloadText(filename, content, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob(['\uFEFF' + content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 根据标题生成安全的文件名 */
export function safeFilename(title, ext = 'md') {
  const base = String(title || '协议风险报告')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  const stamp = new Date().toISOString().slice(0, 10)
  return `${base}_风险报告_${stamp}.${ext}`
}
