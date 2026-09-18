/**
 * 核心逻辑单元测试。
 *
 * 重点覆盖三类最容易出错、且一旦出错就会误导用户的地方：
 *   1. 条款切分的字符偏移（错了前端高亮就会整体错位）
 *   2. 模型 JSON 解析的容错（错了整次分析就白跑）
 *   3. 引文核验（这是"不编造条款"的最后一道防线）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeText, fingerprint, estimateTokens } from '../src/normalize.js'
import { segmentClauses } from '../src/segment.js'
import { parseModelJson, salvageArrayItems, asArray } from '../src/analyze/json.js'
import { locateQuote, verifyFindings, normalizeSeverity, normalizeCategory, buildFuzzyRegex } from '../src/analyze/verify.js'
import { prescan, CATEGORIES, categoryCatalogForPrompt, SEVERITY_WEIGHT } from '../src/analyze/taxonomy.js'
import { heuristicFindings, heuristicReport, computeRiskScore } from '../src/analyze/heuristic.js'
import { batchClauses } from '../src/analyze/pipeline.js'

// ============================================================
// normalize
// ============================================================

test('normalizeText: 清理零宽字符、NBSP 与全角字母数字', () => {
  const { text } = normalizeText('ＡＢＣ１２３\u200B\u00A0测试')
  assert.equal(text, 'ABC123 测试')
})

test('normalizeText: 英文行尾断词还原', () => {
  const { text, stats } = normalizeText('This is an analy-\nsis of the terms.')
  assert.match(text, /analysis/)
  assert.equal(stats.dehyphenated, true)
})

test('normalizeText: 不误伤正常的连字符单词', () => {
  const { text } = normalizeText('a well-known fact and a 3-4 range')
  assert.match(text, /well-known/)
  assert.match(text, /3-4/)
})

test('normalizeText: 去掉纯页码行并压缩多余空行', () => {
  const { text, stats } = normalizeText('第一条 内容\n\n\n\n12\n\n第二条 内容')
  assert.ok(!/\n\n12\n\n/.test(text), '页码行应被移除')
  assert.ok(!/\n{3,}/.test(text), '不应有连续 3 个以上换行')
  assert.equal(stats.removedNoiseLines, 1)
})

test('normalizeText: 统一换行符', () => {
  const { text } = normalizeText('a\r\nb\rc')
  assert.equal(text, 'a\nb\nc')
})

test('fingerprint: 忽略空白与全半角标点差异', () => {
  assert.equal(fingerprint('我们 可能，共享（数据）'), fingerprint('我们可能,共享(数据)'))
})

test('estimateTokens: 中文按字计、英文按字符折算', () => {
  assert.ok(estimateTokens('中文十个字测试一下') >= 9)
  assert.ok(estimateTokens('hello world') < 10)
})

// ============================================================
// segment
// ============================================================

const SAMPLE = `示例平台用户服务协议

第一条 协议的接受与变更
本公司有权随时单方面修改本协议。
您继续使用即视为接受。

第二条 账号与终止
本公司有权随时终止您的账号。账户内余额不予退还。
`

test('segmentClauses: 识别中文「第X条」结构', () => {
  const { clauses, stats } = segmentClauses(SAMPLE)
  assert.equal(stats.strategy, 'structure')
  assert.equal(clauses.length, 2)
  assert.equal(clauses[0].headingRule, 'cn-article')
  assert.match(clauses[1].heading, /^第二条/)
})

test('segmentClauses: 【关键不变量】start/end 必须精确对应 text', () => {
  const { clauses } = segmentClauses(SAMPLE)
  for (const c of clauses) {
    assert.equal(
      SAMPLE.slice(c.start, c.end),
      c.text,
      `条款 ${c.id} 的偏移与文本不一致（高亮会错位）`,
    )
  }
})

test('segmentClauses: 前导空白与空行不会造成偏移漂移', () => {
  const text = '\n\n   \n第一条 测试\n正文内容。\n\n\n第二条 测试二\n更多内容。\n'
  const { clauses } = segmentClauses(text)
  for (const c of clauses) {
    assert.equal(text.slice(c.start, c.end), c.text)
  }
  assert.ok(clauses.length >= 2)
})

test('segmentClauses: 条款区间不重叠且按顺序', () => {
  const { clauses } = segmentClauses(SAMPLE)
  for (let i = 1; i < clauses.length; i++) {
    assert.ok(clauses[i].start >= clauses[i - 1].end, '条款区间不应重叠')
  }
})

test('segmentClauses: id 连续且可用于引用', () => {
  const { clauses } = segmentClauses(SAMPLE)
  clauses.forEach((c, i) => assert.equal(c.id, `c${i + 1}`))
})

test('segmentClauses: 短编号条款不会被合并掉', () => {
  const text = '第九条 生效\n本协议自发布之日起生效。\n\n第十条 其他\n未尽事宜另行规定。'
  const { clauses } = segmentClauses(text)
  assert.equal(clauses.length, 2, '明确的「第X条」边界不可被合并')
})

test('segmentClauses: 识别数字点号编号', () => {
  const text = '1.1 数据收集\n我们收集您的信息。\n\n1.2 数据共享\n我们共享您的信息给第三方合作伙伴。'
  const { clauses } = segmentClauses(text)
  assert.ok(clauses.length >= 2)
  assert.equal(clauses[0].headingRule, 'dotted')
})

test('segmentClauses: 无编号长文本回退到段落聚合', () => {
  const para = '这是一段没有任何编号的协议正文，用来测试段落聚合回退逻辑是否生效。'.repeat(4)
  const text = Array.from({ length: 12 }, () => para).join('\n\n')
  const { clauses, stats } = segmentClauses(text)
  assert.equal(stats.strategy, 'paragraph')
  assert.ok(clauses.length > 1, '应切出多个段落块')
  for (const c of clauses) assert.equal(text.slice(c.start, c.end), c.text)
})

test('segmentClauses: 空文本返回空结果而不是抛错', () => {
  const { clauses, stats } = segmentClauses('')
  assert.equal(clauses.length, 0)
  assert.equal(stats.strategy, 'empty')
})

// ============================================================
// parseModelJson
// ============================================================

test('parseModelJson: 解析纯 JSON', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 })
})

test('parseModelJson: 剥离 markdown 围栏', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseModelJson('```\n{"a":1}\n```'), { a: 1 })
})

test('parseModelJson: 容忍前后解释性文字', () => {
  assert.deepEqual(parseModelJson('好的，分析结果如下：\n{"a":1}\n希望对你有帮助。'), { a: 1 })
})

test('parseModelJson: 修复尾随逗号', () => {
  assert.deepEqual(parseModelJson('{"a":[1,2,],}'), { a: [1, 2] })
})

test('parseModelJson: 修复字符串内的裸换行', () => {
  const r = parseModelJson('{"quote":"第一行\n第二行"}')
  assert.equal(r.quote, '第一行\n第二行')
})

test('parseModelJson: 修复全角引号作定界符', () => {
  assert.deepEqual(parseModelJson('{“a”:1}'), { a: 1 })
})

test('parseModelJson: 截断输出能抢救出完整条目', () => {
  const truncated = '{"findings":[{"clauseId":"c1","severity":"high"},{"clauseId":"c2","sever'
  const warnings = []
  const r = parseModelJson(truncated, { salvageKey: 'findings', warnings })
  assert.equal(r.__salvaged, true)
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].clauseId, 'c1')
  assert.ok(warnings.length > 0, '应记录截断告警')
})

test('parseModelJson: 完全无法解析时抛出明确错误', () => {
  assert.throws(() => parseModelJson('这里根本没有 JSON'), /无法从模型输出中解析 JSON/)
})

test('asArray: 归一化为数组', () => {
  assert.deepEqual(asArray([1]), [1])
  assert.deepEqual(asArray(1), [1])
  assert.deepEqual(asArray(null), [])
})

test('salvageArrayItems: 逐个捞出完整对象', () => {
  const items = salvageArrayItems('{"list":[{"a":1},{"b":2},{"c":', 'list')
  assert.equal(items.length, 2)
})

// ============================================================
// 引文核验 —— "不编造条款" 的最后一道防线
// ============================================================

function buildClauseMap(text) {
  const { clauses } = segmentClauses(text)
  return { clauses, map: new Map(clauses.map((c) => [c.id, c])) }
}

test('verifyFindings: 精确引文通过核验并给出精确偏移', () => {
  const { clauses, map } = buildClauseMap(SAMPLE)
  const quote = '本公司有权随时终止您的账号。'
  const { findings, stats } = verifyFindings(
    [{ clauseId: 'c2', category: 'account_termination', severity: 'high', quote, title: 't' }],
    map,
    { docText: SAMPLE },
  )
  assert.equal(stats.kept, 1)
  assert.equal(findings[0].matchType, 'exact')
  assert.equal(SAMPLE.slice(findings[0].start, findings[0].end), quote)
  assert.equal(clauses.length, 2)
})

test('verifyFindings: 引文含换行差异时仍能核验（容错匹配）', () => {
  const { map } = buildClauseMap(SAMPLE)
  // 模型把原文的换行写成了空格
  const { findings, stats } = verifyFindings(
    [{ clauseId: 'c2', quote: '本公司有权随时终止您的账号。 账户内余额不予退还。', category: 'refund', severity: 'medium', title: 't' }],
    map,
    { docText: SAMPLE },
  )
  assert.equal(stats.kept, 1)
  assert.equal(stats.fuzzy, 1)
  assert.equal(findings[0].matchType, 'fuzzy')
})

test('verifyFindings: 展示引文与原文切片一致（所见即所在）', () => {
  const { map } = buildClauseMap(SAMPLE)
  const { findings } = verifyFindings(
    [{ clauseId: 'c1', quote: '本公司有权随时单方面修改本协议。 您继续使用即视为接受。', category: 'unilateral_change', severity: 'high', title: 't' }],
    map,
    { docText: SAMPLE },
  )
  const f = findings[0]
  assert.equal(SAMPLE.slice(f.start, f.end), f.quote)
})

test('verifyFindings: 全半角标点差异也能核验', () => {
  const text = '第一条 数据\n我们可能将您的信息共享给第三方（合作伙伴）。'
  const { map } = buildClauseMap(text)
  const { findings, stats } = verifyFindings(
    [{ clauseId: 'c1', quote: '我们可能将您的信息共享给第三方(合作伙伴)。', category: 'data_sharing', severity: 'high', title: 't' }],
    map,
    { docText: text },
  )
  assert.equal(stats.kept, 1)
  assert.equal(text.slice(findings[0].start, findings[0].end), findings[0].quote)
})

test('verifyFindings: 编造的引文被丢弃', () => {
  const { map } = buildClauseMap(SAMPLE)
  const { findings, stats } = verifyFindings(
    [{ clauseId: 'c1', quote: '本协议要求用户放弃一切法律权利并支付巨额罚金。', category: 'other', severity: 'critical', title: '编造' }],
    map,
    { docText: SAMPLE },
  )
  assert.equal(findings.length, 0)
  assert.equal(stats.dropped, 1)
})

test('verifyFindings: 无引文的结论被丢弃', () => {
  const { map } = buildClauseMap(SAMPLE)
  const { stats } = verifyFindings([{ clauseId: 'c1', category: 'other', severity: 'high' }], map, { docText: SAMPLE })
  assert.equal(stats.droppedNoQuote, 1)
})

test('verifyFindings: clauseId 错误时用引文反查真实条款', () => {
  const { map } = buildClauseMap(SAMPLE)
  const { findings } = verifyFindings(
    [{ clauseId: 'c999', quote: '账户内余额不予退还。', category: 'refund', severity: 'medium', title: 't' }],
    map,
    { docText: SAMPLE },
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].clauseId, 'c2', '应修正到真正包含该引文的条款')
})

test('verifyFindings: 空安全', () => {
  const { map } = buildClauseMap(SAMPLE)
  assert.equal(verifyFindings(null, map, {}).findings.length, 0)
  assert.equal(verifyFindings([null, 'x', 42], map, {}).findings.length, 0)
})

test('verifyFindings: 结果按风险等级排序', () => {
  const { map } = buildClauseMap(SAMPLE)
  const { findings } = verifyFindings(
    [
      { clauseId: 'c1', quote: '您继续使用即视为接受。', category: 'other', severity: 'low', title: 'a' },
      { clauseId: 'c2', quote: '账户内余额不予退还。', category: 'refund', severity: 'critical', title: 'b' },
    ],
    map,
    { docText: SAMPLE },
  )
  assert.equal(findings[0].severity, 'critical')
  assert.equal(findings[1].severity, 'low')
})

test('normalizeSeverity: 中英文与各式写法归一', () => {
  assert.equal(normalizeSeverity('严重'), 'critical')
  assert.equal(normalizeSeverity('CRITICAL'), 'critical')
  assert.equal(normalizeSeverity('高'), 'high')
  assert.equal(normalizeSeverity('中等'), 'medium')
  assert.equal(normalizeSeverity('轻微'), 'low')
  assert.equal(normalizeSeverity('提示'), 'info')
  assert.equal(normalizeSeverity(undefined), 'medium')
})

test('normalizeCategory: 未知类别兜底为 other', () => {
  assert.equal(normalizeCategory('data_sharing'), 'data_sharing')
  assert.equal(normalizeCategory('数据收集与第三方共享'), 'data_sharing')
  assert.equal(normalizeCategory('完全没听过的类别'), 'other')
  assert.equal(normalizeCategory(undefined), 'other')
})

test('locateQuote: 找不到时返回 null', () => {
  assert.equal(locateQuote('不存在的句子', '一段普通文本'), null)
  assert.equal(locateQuote('', 'abc'), null)
})

test('buildFuzzyRegex: 空白与标点容错', () => {
  const re = buildFuzzyRegex('我们 共享（数据）')
  assert.ok(re.test('我们共享(数据)'))
})

// ============================================================
// taxonomy / heuristic
// ============================================================

test('taxonomy: 每个类别都有必需字段且 id 唯一', () => {
  const ids = new Set()
  for (const c of CATEGORIES) {
    assert.ok(c.id && c.label && c.group && c.what && c.why, `类别 ${c.id} 字段不完整`)
    assert.ok(!ids.has(c.id), `类别 id 重复：${c.id}`)
    ids.add(c.id)
    assert.ok(Array.isArray(c.signals))
  }
  assert.ok(CATEGORIES.length >= 20, '类别数量应足够覆盖常见坑点')
})

test('taxonomy: 提示词清单包含全部分类', () => {
  const catalog = categoryCatalogForPrompt()
  for (const c of CATEGORIES) assert.ok(catalog.includes(c.id), `清单缺少 ${c.id}`)
})

test('prescan: 命中典型红旗措辞并给出偏移', () => {
  const { clauses } = segmentClauses(SAMPLE)
  const hits = prescan(clauses)
  assert.ok(hits.length > 0)
  const cats = hits.map((h) => h.category)
  assert.ok(cats.includes('unilateral_change'))
  assert.ok(cats.includes('account_termination'))
  for (const h of hits) {
    assert.equal(h.matchIndexes.length, h.matches.length)
    assert.ok(h.matchIndexes.every((i) => i >= 0))
  }
})

test('prescan: 对正常条款不应误报', () => {
  const text = '第一条 服务内容\n我们为您提供在线文档编辑服务，支持多人协作。\n\n第二条 联系方式\n如有疑问请联系客服邮箱。'
  const { clauses } = segmentClauses(text)
  const hits = prescan(clauses)
  const noisy = hits.filter((h) => ['content_license', 'arbitration', 'auto_renewal'].includes(h.category))
  assert.equal(noisy.length, 0, '不应把中性条款误判为高风险类别')
})

test('heuristicFindings: 引文与偏移必须自洽', () => {
  const { clauses } = segmentClauses(SAMPLE)
  const findings = heuristicFindings(clauses)
  assert.ok(findings.length > 0)
  for (const f of findings) {
    assert.ok(f.start >= 0 && f.end > f.start)
    assert.equal(SAMPLE.slice(f.start, f.end), f.quote, '规则发现的引文应与原文切片一致')
  }
})

test('heuristicFindings: 标题中的关键词不会让引文变成标题', () => {
  const text = '第五条 费用与自动续费\n会员服务费用一经支付不予退还。免费试用期结束后将自动续费并按月自动扣款。'
  const { clauses } = segmentClauses(text)
  const findings = heuristicFindings(clauses)
  const auto = findings.find((f) => f.category === 'auto_renewal')
  assert.ok(auto, '应识别出自动续费')
  assert.ok(!/^第五条/.test(auto.quote), `引文不应是标题，实际为：${auto.quote}`)
  assert.match(auto.quote, /自动续费/)
})

test('computeRiskScore: 无发现时为 0，且随严重度单调递增', () => {
  assert.equal(computeRiskScore([]), 0)
  const low = computeRiskScore([{ severity: 'low' }])
  const high = computeRiskScore([{ severity: 'high' }])
  const critical = computeRiskScore([{ severity: 'critical' }])
  assert.ok(low < high && high < critical)
  assert.ok(critical <= 100)
})

test('computeRiskScore: 分数有上限，不会溢出', () => {
  const many = Array.from({ length: 200 }, () => ({ severity: 'critical' }))
  const score = computeRiskScore(many)
  assert.ok(score <= 100 && score >= 95, `大量严重条款应接近 100，实际 ${score}`)
})

test('SEVERITY_WEIGHT: 每个等级都有权重', () => {
  for (const s of ['critical', 'high', 'medium', 'low', 'info']) {
    assert.ok(SEVERITY_WEIGHT[s] > 0, `缺少等级 ${s} 的权重`)
  }
})

test('heuristicReport: 报告字段完整且风险分自洽', () => {
  const { clauses } = segmentClauses(SAMPLE)
  const findings = heuristicFindings(clauses)
  const report = heuristicReport(findings, { clauseCount: clauses.length, totalChars: SAMPLE.length })
  assert.ok(Number.isFinite(report.riskScore))
  assert.equal(report.riskScore, computeRiskScore(findings))
  assert.ok(report.verdict)
  assert.ok(report.summary.length > 20)
  assert.ok(Array.isArray(report.topConcerns))
  assert.ok(Array.isArray(report.actions))
  assert.ok(report.categorySummary.length > 0)
})

test('heuristicReport: 零发现时给出诚实的低风险说明', () => {
  const report = heuristicReport([], { clauseCount: 1, totalChars: 100 })
  assert.equal(report.riskScore, 0)
  assert.match(report.summary, /未.*发现|没有/)
})

// ============================================================
// 分片
// ============================================================

test('batchClauses: 按字符预算切分且不丢条款', () => {
  const clauses = Array.from({ length: 10 }, (_, i) => ({ id: `c${i + 1}`, text: 'x'.repeat(100) }))
  const batches = batchClauses(clauses, 250)
  assert.ok(batches.length > 1)
  const flat = batches.flat()
  assert.equal(flat.length, 10, '不得丢失条款')
  assert.deepEqual(flat.map((c) => c.id), clauses.map((c) => c.id), '顺序必须保持')
})

test('batchClauses: 单条超长条款独占一批而不是被丢弃', () => {
  const clauses = [{ id: 'c1', text: 'x'.repeat(5000) }, { id: 'c2', text: 'y'.repeat(10) }]
  const batches = batchClauses(clauses, 100)
  assert.equal(batches.flat().length, 2)
  assert.equal(batches[0].length, 1)
})
