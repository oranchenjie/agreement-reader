/**
 * 检索模块测试。
 *
 * 检索质量直接决定问答会不会「编造」：相关条款没召回，模型手里没依据；
 * 召回一堆无关条款，模型反而会硬答。所以这里要同时验证「召得回」和「不乱召」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tokenize, buildIndex, search, documentFromResult, expandQuestion } from '../src/analyze/retrieve.js'

const DOC = {
  id: 'doc1',
  title: '示例平台用户服务协议',
  clauses: [
    { id: 'c1', heading: '第一条 协议的接受与变更', text: '本公司有权随时单方面修改本协议，且无需另行通知您。您继续使用本服务即视为接受修改后的协议。', index: 0 },
    { id: 'c2', heading: '第二条 账号与终止', text: '本公司有权随时暂停或终止您的账号，无需事先通知。账号被终止的，账户内余额不予退还。', index: 1 },
    { id: 'c3', heading: '第三条 内容授权', text: '您在本平台上传、发布的所有内容，您授予本公司全球范围内永久、不可撤销、免费、可转授权的许可。', index: 2 },
    { id: 'c4', heading: '第四条 隐私与数据', text: '我们可能收集您的位置信息、设备信息、通讯录及浏览行为，并可能将上述信息共享给我们的关联方及合作伙伴用于个性化广告推荐。', index: 3 },
    { id: 'c5', heading: '第五条 费用与自动续费', text: '会员服务费用一经支付不予退还。免费试用期结束后将自动续费并按月自动扣款。', index: 4 },
    { id: 'c6', heading: '第六条 争议解决', text: '因本协议产生的争议，双方应提交北京仲裁委员会仲裁，一裁终局。您放弃以集体诉讼方式主张权利。', index: 5 },
  ],
}

// ============================================================
// 分词
// ============================================================

test('tokenize: 中文切成 bigram', () => {
  const t = tokenize('自动续费')
  assert.ok(t.includes('自动'), '应含 bigram「自动」')
  assert.ok(t.includes('动续'), '应含 bigram「动续」')
  assert.ok(t.includes('续费'), '应含 bigram「续费」')
})

test('tokenize: 英文数字按词切分并小写', () => {
  const t = tokenize('Auto-Renewal 2026 FEE')
  assert.ok(t.includes('auto-renewal'))
  assert.ok(t.includes('2026'))
  assert.ok(t.includes('fee'))
})

test('tokenize: 中英混排都能切', () => {
  const t = tokenize('根据 GDPR 第17条 删除')
  assert.ok(t.some((x) => x.includes('gdpr')))
  assert.ok(t.includes('删除'))
})

test('tokenize: 空输入返回空数组', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
})

// ============================================================
// 索引与检索
// ============================================================

test('search: 「自动续费」应召回费用条款', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '自动续费怎么取消', { topK: 2, neighbors: 0 })
  assert.equal(passages[0].clauseId, 'c5', `实际首位：${passages[0]?.clauseId}`)
})

test('search: 「内容被永久使用」应召回内容授权条款', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '我的内容会被永久使用吗', { topK: 2, neighbors: 0 })
  assert.equal(passages[0].clauseId, 'c3', `实际首位：${passages[0]?.clauseId}`)
})

test('search: 「卖我的数据」应召回隐私条款', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '这个平台会不会卖掉我的数据', { topK: 3, neighbors: 0 })
  assert.ok(passages.some((p) => p.clauseId === 'c4'), `实际：${passages.map((p) => p.clauseId)}`)
})

test('search: 「强制仲裁」应召回争议解决条款', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '有没有强制仲裁', { topK: 2, neighbors: 0 })
  assert.equal(passages[0].clauseId, 'c6')
})

test('search: 无关问题不应召回任何条款', () => {
  const index = buildIndex([DOC])
  const { passages, stats } = search(index, '午饭吃什么比较好', { topK: 5 })
  assert.equal(passages.length, 0, `不该命中，实际：${passages.map((p) => p.clauseId)}`)
  assert.equal(stats.scored, 0)
})

test('search: 结果按分数降序', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '账号 余额 终止', { topK: 4, neighbors: 0 })
  for (let i = 1; i < passages.length; i++) {
    assert.ok(passages[i - 1].score >= passages[i].score, '分数应单调不增')
  }
})

test('search: 邻接扩展会把相邻条款一并带回', () => {
  const index = buildIndex([DOC])
  const withNeighbors = search(index, '自动续费', { topK: 1, neighbors: 1 })
  const without = search(index, '自动续费', { topK: 1, neighbors: 0 })
  assert.ok(withNeighbors.passages.length > without.passages.length, '开启邻接后应带回更多上下文')
  assert.ok(withNeighbors.stats.expanded > 0)
})

test('search: 遵守 maxChars 预算', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '协议', { topK: 10, maxChars: 100, neighbors: 0 })
  const total = passages.reduce((s, p) => s + p.text.length, 0)
  assert.ok(total <= 100 || passages.length === 1, `总长度 ${total} 应受预算约束`)
})

test('search: 结果去重（邻接不会重复带回同一条）', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '账号 终止 余额 数据', { topK: 8, neighbors: 2 })
  const keys = passages.map((p) => `${p.docId}|${p.clauseId}`)
  assert.equal(new Set(keys).size, keys.length, '不应出现重复条款')
})

test('search: 空查询 / 空索引安全返回', () => {
  const index = buildIndex([DOC])
  assert.equal(search(index, '', { topK: 3 }).passages.length, 0)
  assert.equal(search(buildIndex([]), '任意问题', { topK: 3 }).passages.length, 0)
  assert.equal(search(null, '任意问题', { topK: 3 }).passages.length, 0)
})

// ============================================================
// 多文档
// ============================================================

test('search: 多份协议时结果带来源标识，且能区分文档', () => {
  const docB = {
    id: 'doc2',
    title: '另一个平台隐私政策',
    clauses: [
      { id: 'c1', heading: '一、信息收集', text: '我们会收集您的设备标识符与粗略位置信息，用于安全风控与统计分析。', index: 0 },
      { id: 'c2', heading: '二、信息共享', text: '除法律法规要求外，我们不会向任何第三方出售您的个人信息。', index: 1 },
    ],
  }
  const index = buildIndex([DOC, docB])
  const { passages } = search(index, '会不会把我的信息卖给第三方', { topK: 4, neighbors: 0 })

  assert.ok(passages.length > 0)
  assert.ok(passages.every((p) => p.docId && p.docTitle), '每条结果都要能追溯来源文档')
  const docIds = new Set(passages.map((p) => p.docId))
  assert.ok(docIds.size >= 1)
  // 同一 clauseId 出现在不同文档时不应被误判为重复
  const keys = passages.map((p) => `${p.docId}|${p.clauseId}`)
  assert.equal(new Set(keys).size, keys.length)
})

// ============================================================
// 从分析结果还原文档
// ============================================================

test('documentFromResult: 用偏移从 doc.text 还原条款正文', () => {
  const text = '第一条 测试\n正文甲。\n\n第二条 测试二\n正文乙。'
  const result = {
    id: 'r1',
    doc: { title: '测试协议', text },
    clauses: [
      { id: 'c1', heading: '第一条 测试', start: 0, end: 13, index: 0 },
      { id: 'c2', heading: '第二条 测试二', start: 14, end: 29, index: 1 },
    ],
  }
  const doc = documentFromResult(result)
  assert.equal(doc.title, '测试协议')
  assert.equal(doc.clauses.length, 2)
  assert.equal(doc.clauses[0].text, text.slice(0, 13))
  assert.match(doc.clauses[1].text, /正文乙/)
})

test('documentFromResult: 跳过没有正文的条款', () => {
  const result = {
    doc: { title: 'x', text: 'abc' },
    clauses: [
      { id: 'c1', start: 0, end: 3 },
      { id: 'c2', start: 3, end: 3 }, // 空区间
    ],
  }
  const doc = documentFromResult(result)
  assert.equal(doc.clauses.length, 1)
})

test('documentFromResult: 对畸形输入不抛异常', () => {
  assert.doesNotThrow(() => documentFromResult(null))
  assert.doesNotThrow(() => documentFromResult({}))
  assert.equal(documentFromResult(null).clauses.length, 0)
})

test('端到端：还原 → 索引 → 检索 链路可用', () => {
  const text = DOC.clauses.map((c) => `${c.heading}\n${c.text}`).join('\n\n')
  let pos = 0
  const clauses = DOC.clauses.map((c, i) => {
    const body = `${c.heading}\n${c.text}`
    const start = pos
    const end = pos + body.length
    pos = end + 2
    return { id: c.id, heading: c.heading, start, end, index: i }
  })
  const index = buildIndex([documentFromResult({ id: 'rt', doc: { title: 'T', text }, clauses })])
  const { passages } = search(index, '自动续费与退款', { topK: 2, neighbors: 0 })
  assert.equal(passages[0].clauseId, 'c5')
})


// ============================================================
// 口语化提问的同义词扩展（实测踩坑后的回归护栏）
// ============================================================

test('expandQuestion: 「付了钱能退吗」扩展到退款相关词', () => {
  const extra = expandQuestion('付了钱能退吗？')
  assert.ok(extra.length > 0, '应扩展出额外检索词')
  assert.ok(extra.some((t) => t.includes('退')), `实际：${extra.join(',')}`)
})

test('expandQuestion: 「账号被封」扩展到终止/封禁', () => {
  const extra = expandQuestion('账号被封了怎么办')
  assert.ok(extra.some((t) => t.includes('封') || t.includes('终止') || t.includes('暂停')), extra.join(','))
})

test('expandQuestion: 数据共享的两种语序都能命中', () => {
  assert.ok(expandQuestion('我的数据会被共享给谁').length > 0, '「数据…共享」语序')
  assert.ok(expandQuestion('你们会共享我的信息吗').length > 0, '「共享…信息」语序')
})

test('expandQuestion: 无关问题不产生扩展', () => {
  assert.equal(expandQuestion('今天天气怎么样').length, 0)
})

test('expandQuestion: 空输入安全', () => {
  assert.deepEqual(expandQuestion(''), [])
  assert.deepEqual(expandQuestion(null), [])
})

test('【实测回归】口语化提问能命中对应的协议条款', () => {
  const index = buildIndex([DOC])
  // 这句话的 bigram 与协议用语几乎零重叠，纯词法检索原本会一无所获
  const { passages } = search(index, '付了钱能退吗？', { topK: 3, neighbors: 0 })
  assert.ok(passages.length > 0, '同义词扩展后应能命中')
  assert.ok(passages.some((p) => p.clauseId === 'c5'), `应命中费用条款，实际：${passages.map((p) => p.clauseId)}`)
})

test('loose 模式：放宽判据后能召回更多（用于 strict 一无所获时兜底）', () => {
  const index = buildIndex([DOC])
  const strict = search(index, '公司', { topK: 5, neighbors: 0, mode: 'strict' })
  const loose = search(index, '公司', { topK: 5, neighbors: 0, mode: 'loose' })
  assert.ok(loose.passages.length >= strict.passages.length, 'loose 不应少于 strict')
  assert.equal(loose.stats.mode, 'loose')
})

test('loose 模式仍然不会把完全无关的问题召回', () => {
  const index = buildIndex([DOC])
  const { passages } = search(index, '午饭吃什么比较好', { topK: 5, mode: 'loose' })
  assert.equal(passages.length, 0, `不该命中，实际：${passages.map((p) => p.clauseId)}`)
})

// ============================================================
// 历史记录被截断的检测（会导致"莫名其妙找不到"）
// ============================================================

test('documentFromResult: 正文被截断时标记出来', () => {
  // 正文只存了前 10 个字，但条款区间一直到 100
  const result = {
    doc: { title: 'T', text: '0123456789', textTruncated: true },
    clauses: [
      { id: 'c1', heading: 'a', start: 0, end: 5, index: 0 },
      { id: 'c2', heading: 'b', start: 5, end: 100, index: 1 },
    ],
  }
  const doc = documentFromResult(result)
  assert.equal(doc.truncated, true, '应标记为已截断')
  assert.ok(doc.lostClauses >= 1, `应数出丢失的条款，实际 ${doc.lostClauses}`)
})

test('documentFromResult: 未截断时不误报', () => {
  const text = '第一条 甲\n内容甲。\n第二条 乙\n内容乙。'
  const result = {
    doc: { title: 'T', text },
    clauses: [
      { id: 'c1', heading: '第一条 甲', start: 0, end: 11, index: 0 },
      { id: 'c2', heading: '第二条 乙', start: 12, end: text.length, index: 1 },
    ],
  }
  const doc = documentFromResult(result)
  assert.equal(doc.truncated, false)
  assert.equal(doc.lostClauses, 0)
})
