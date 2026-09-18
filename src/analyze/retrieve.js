/**
 * 协议检索（Retrieval）。
 *
 * 问答要「严格基于协议」，前提是先把**相关条款**找出来喂给模型。
 * 这里刻意不引入 embedding：一来要满足零依赖，二来本地运行不该把整份协议
 * 再发一次给第三方做向量化。用词法检索（BM25 思路）在协议这种用词重复度高、
 * 术语集中的文本上效果已经够用，而且完全可解释、可离线。
 *
 * 检索质量直接决定问答是否会「编造」：
 * 如果相关条款没被召回，模型手里没有依据，就只能说"没找到"（正确行为）；
 * 但如果召回了无关条款，模型反而可能硬答。所以这里宁可多召回、并做邻接扩展。
 */

/** 中文按 bigram、英文数字按词切分 */
export function tokenize(text) {
  const s = String(text ?? '')
  const tokens = []

  // 英文 / 数字：保留内部连字符与撇号（如 "third-party"、"user's"）
  for (const m of s.matchAll(/[a-zA-Z][a-zA-Z0-9'-]*|\d+/g)) {
    tokens.push(m[0].toLowerCase())
  }

  // 中文：连续汉字串切成 bigram；单字串保留自身
  const runs = s.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]+/g) ?? []
  for (const run of runs) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
  }

  return tokens
}

/**
 * 口语化提问 → 协议用语 的映射。
 *
 * 这是实测踩出来的坑：用户问「付了钱能退吗？」，切出来的 bigram 是
 * 付了/了钱/钱能/能退/退吗，而协议里写的是「退款」「不予退还」「费用」——
 * 字面上毫无重叠，纯词法检索一个都匹配不上，于是系统会错误地告诉用户"协议里没写"。
 *
 * 带上这层扩展后，同一个问题会额外用「退款/退还/费用」去找，命中率大幅提升。
 * 这只是**补充候选词**，不是替用户改写问题，也不参与任何结论生成。
 */
const QUERY_SYNONYMS = [
  { when: /退(钱|费|款)|能退|想退|可以退|退款/, add: ['退款', '退还', '不予退还', '费用', '支付'] },
  { when: /封号|被封|账号.{0,4}(停|禁|没|注销)|注销/, add: ['暂停', '终止', '封禁', '注销', '账号'] },
  {
    // 语序不固定：「数据会被共享」和「共享数据」都要命中
    when: /(数据|信息|资料|隐私).{0,8}(共享|提供|披露|出售|卖出|卖给|泄露|给谁)|(共享|提供|披露|出售|卖出|卖给|泄露).{0,8}(数据|信息|资料)|第三方|关联方|隐私/,
    add: ['共享', '提供', '披露', '第三方', '关联方', '合作伙伴', '个人信息'],
  },
  { when: /自动|续费|扣费|扣款|订阅/, add: ['自动续费', '扣款', '订阅', '期满', '到期'] },
  { when: /我.{0,4}(内容|作品|文章|发的|上传)|原创|版权|著作权/, add: ['内容', '上传', '发布', '许可', '授权', '知识产权'] },
  { when: /追踪|跟踪|监控|定位|行踪|行为/, add: ['收集', '追踪', '位置', '设备', '浏览'] },
  { when: /删(除|掉)|注销后|保留多久|保存多久/, add: ['删除', '保留', '存储', '期限', '注销'] },
  { when: /赔|责任|损失|出事|坏了/, add: ['责任', '赔偿', '免责', '损失', '不承担'] },
  { when: /争议|起诉|打官司|仲裁|法院|维权/, add: ['仲裁', '管辖', '争议', '诉讼', '法院'] },
  { when: /改.{0,4}(协议|条款|规则)|变更|修改|更新/, add: ['修改', '变更', '通知', '更新', '调整'] },
  { when: /未成年|小孩|儿童|孩子/, add: ['未成年', '监护人', '法定代理人', '儿童'] },
  { when: /收费|多少钱|价格|付费|会员/, add: ['费用', '价格', '付费', '会员', '服务费'] },
]

/**
 * 把问题扩展成更适合检索的词项集合。
 * @param {string} question
 * @returns {string[]} 额外加入的检索词（已切分为 token）
 */
export function expandQuestion(question) {
  const q = String(question ?? '')
  const extra = []
  for (const rule of QUERY_SYNONYMS) {
    if (rule.when.test(q)) {
      for (const term of rule.add) extra.push(...tokenize(term))
    }
  }
  return [...new Set(extra)]
}

/** 查询词切分并去重 */
function tokenizeQuery(text) {
  return [...new Set(tokenize(text))]
}

/**
 * 从分析结果还原成可检索的文档。
 * 分析结果里 clauses 只有偏移，正文在 doc.text 里，这里做一次还原。
 *
 * @param {object} result 分析结果（或历史记录里的 result）
 * @param {string} [fallbackTitle]
 * @returns {{id:string,title:string,clauses:Array<{id:string,heading:string,text:string,index:number}>}}
 */
export function documentFromResult(result, fallbackTitle) {
  const text = result?.doc?.text ?? ''
  const clauses = Array.isArray(result?.clauses) ? result.clauses : []
  const out = []
  let lostClauses = 0

  for (const c of clauses) {
    let body = ''
    if (typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start) {
      body = text.slice(c.start, c.end)
      // 条款区间超出正文长度 → 说明正文被截断过（历史记录为省空间会截断），
      // 这一段内容已经丢失。静默丢弃会让问答莫名其妙地"找不到"，
      // 所以这里数出来，交给上层明确告知用户。
      if (c.end > text.length) lostClauses++
    }
    if (!body.trim()) continue
    out.push({
      id: c.id,
      heading: c.heading ?? '',
      text: body,
      index: typeof c.index === 'number' ? c.index : out.length,
    })
  }

  return {
    id: result?.id ?? `doc-${Math.random().toString(36).slice(2, 8)}`,
    title: result?.doc?.title || fallbackTitle || '未命名协议',
    clauses: out,
    /** 正文被截断过（或仍有条款落在截断范围外） */
    truncated: result?.doc?.textTruncated === true || lostClauses > 0,
    lostClauses,
    declaredClauses: clauses.length,
  }
}

/**
 * 建立倒排索引。
 * @param {Array<{id:string,title:string,clauses:Array}>} docs
 */
export function buildIndex(docs) {
  const entries = []
  const df = new Map()

  for (const doc of docs ?? []) {
    for (const clause of doc.clauses ?? []) {
      if (!clause.text?.trim()) continue

      const bodyTokens = tokenize(clause.text)
      const headTokens = tokenize(clause.heading ?? '')

      const tf = new Map()
      const bump = (t, w) => tf.set(t, (tf.get(t) ?? 0) + w)
      for (const t of bodyTokens) bump(t, 1)
      // 标题命中应当比正文命中更有指示性
      for (const t of headTokens) bump(t, 3)

      if (tf.size === 0) continue

      entries.push({
        docId: doc.id,
        docTitle: doc.title,
        clauseId: clause.id,
        heading: clause.heading ?? '',
        text: clause.text,
        index: clause.index ?? 0,
        tf,
        length: bodyTokens.length + headTokens.length * 3 || 1,
      })
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    }
  }

  const total = entries.length || 1
  const idf = new Map()
  for (const [t, n] of df) {
    // BM25 的 idf 形式，恒为正
    idf.set(t, Math.log(1 + (total - n + 0.5) / (n + 0.5)))
  }

  return { entries, idf, total }
}

/**
 * 检索最相关的条款。
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} question
 * @param {{ topK?:number, maxChars?:number, neighbors?:number }} [opts]
 * @returns {{ passages:Array<{docId,docTitle,clauseId,heading,text,score}>, stats:object }}
 */
export function search(index, question, opts = {}) {
  const topK = opts.topK ?? 8
  const maxChars = opts.maxChars ?? 20000
  const neighbors = opts.neighbors ?? 1
  /**
   * strict：要求命中至少一个「判别性」词（默认）。
   * loose ：只要有任何词命中就收 —— 用于 strict 一无所获时兜底，
   *         因为口语化提问和协议用语经常在字面上完全不重叠。
   */
  const mode = opts.mode === 'loose' ? 'loose' : 'strict'

  // 查询词 = 原问题的 bigram + 口语同义词扩展
  const terms = [...new Set([...tokenizeQuery(question), ...expandQuestion(question)])]
  if (!index?.entries?.length || terms.length === 0) {
    return { passages: [], stats: { terms: terms.length, scored: 0, expanded: 0, chars: 0 } }
  }

  const K1 = 1.2
  const B = 0.75
  const avgLen = index.entries.reduce((s, e) => s + e.length, 0) / index.entries.length || 1

  // 判定「相关」的核心：**至少要命中一个足够稀有的词**。
  //
  // 只命中「公司」「我们」这类到处都出现的词，说明不了任何相关性 ——
  // 否则问"公司年会在哪办"也会命中一堆条款，然后模型就会硬答。
  // 反过来，命中「仲裁」「自动续费」这种只出现在个别条款里的词，才说明真的相关。
  //
  // 阈值取该语料 idf 的中位数：比一半词更稀有才算"有信息量"。
  const allIdf = [...index.idf.values()].sort((a, b) => a - b)
  const medianIdf = allIdf.length ? allIdf[Math.floor(allIdf.length / 2)] : 0
  const minMatchIdf = opts.minMatchIdf ?? medianIdf * 0.5

  const scored = []
  for (const e of index.entries) {
    let score = 0
    let matched = 0
    let maxMatchedIdf = 0
    for (const t of terms) {
      const f = e.tf.get(t)
      if (!f) continue
      matched++
      const idf = index.idf.get(t) ?? 0
      if (idf > maxMatchedIdf) maxMatchedIdf = idf
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (e.length / avgLen))))
    }
    if (score <= 0) continue
    if (mode === 'strict' && maxMatchedIdf < minMatchIdf) continue

    score *= 1 + matched / terms.length
    scored.push({ entry: e, score })
  }

  scored.sort((a, b) => b.score - a.score)

  const picked = new Map() // key: docId|clauseId
  const passages = []
  let chars = 0

  const push = (entry, score) => {
    const key = `${entry.docId}|${entry.clauseId}`
    if (picked.has(key)) return false
    if (chars + entry.text.length > maxChars && passages.length > 0) return false
    picked.set(key, true)
    passages.push({
      docId: entry.docId,
      docTitle: entry.docTitle,
      clauseId: entry.clauseId,
      heading: entry.heading,
      text: entry.text,
      score: Number(score.toFixed(3)),
    })
    chars += entry.text.length
    return true
  }

  for (const { entry, score } of scored) {
    if (passages.length >= topK) break
    push(entry, score)
  }

  // 邻接扩展：答案常常写在紧邻的条款里，只靠词面命中会漏
  let expanded = 0
  if (neighbors > 0) {
    const byDoc = new Map()
    for (const e of index.entries) {
      if (!byDoc.has(e.docId)) byDoc.set(e.docId, [])
      byDoc.get(e.docId).push(e)
    }
    for (const list of byDoc.values()) list.sort((a, b) => a.index - b.index)

    const seeds = [...passages]
    for (const p of seeds) {
      const list = byDoc.get(p.docId) ?? []
      const at = list.findIndex((e) => e.clauseId === p.clauseId)
      if (at === -1) continue
      for (let d = 1; d <= neighbors; d++) {
        for (const i of [at - d, at + d]) {
          const e = list[i]
          if (!e) continue
          if (push(e, p.score * 0.5)) expanded++
        }
      }
    }
  }

  return {
    passages,
    stats: {
      terms: terms.length,
      scored: scored.length,
      filtered: index.entries.length - scored.length,
      mode,
      minMatchIdf: Number(minMatchIdf.toFixed(3)),
      expanded,
      chars,
    },
  }
}
