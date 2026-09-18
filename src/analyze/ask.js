/**
 * 协议问答（严格基于协议）。
 *
 * 产品承诺是「回答不允许胡编乱造」，因此这里做了三层约束：
 *
 *   1. **检索层**：只把真正相关的条款喂给模型。手里没有依据，模型才可能说"没找到"。
 *   2. **提示层**：ASK_SYSTEM 明确要求"找不到就说找不到"，禁止用常识填补。
 *   3. **核验层（关键）**：模型给出的每条依据都要在原文里定位。**如果一条都对不上，
 *      那么无论模型说得多肯定，都强制改判为"协议中未找到依据"。**
 *
 * 第三层是这套机制与"直接问 AI"的本质区别：模型可以声称有依据，但无法伪造依据。
 */
import { config, resolveRuntime } from '../config.js'
import { chatJSON } from './client.js'
import { ASK_SYSTEM, buildAskUser } from './prompts.js'
import { locateQuote } from './verify.js'
import { buildIndex, search, documentFromResult } from './retrieve.js'

/** 单条依据最短长度：太短（如"我们"）没有核验意义 */
const MIN_EVIDENCE_CHARS = 6

function clean(v, max) {
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max)
}

const CONFIDENCES = new Set(['high', 'medium', 'low'])
function normalizeConfidence(v) {
  const s = String(v ?? '').trim().toLowerCase()
  return CONFIDENCES.has(s) ? s : 'low'
}

/**
 * 可选地做一次联网搜索。搜索模块或网络不可用时静默降级。
 * @returns {Promise<{ used:boolean, results:Array, text:string, warnings:string[], provider:string }>}
 */
async function maybeWebSearch(question, useWeb, signal) {
  const result = { used: false, results: [], text: '', warnings: [], provider: 'none' }
  if (!useWeb) return result

  if (!config.webSearchEnabled) {
    result.warnings.push('服务端已通过 WEB_SEARCH=0 关闭联网搜索。')
    return result
  }

  let mod
  try {
    mod = await import('./websearch.js')
  } catch {
    result.warnings.push('联网搜索模块不可用（未安装或加载失败），本次仅依据协议回答。')
    return result
  }

  try {
    const res = await mod.webSearch(question, {
      maxResults: config.webSearchMaxResults,
      timeoutMs: config.webSearchTimeoutMs,
      signal,
    })
    result.warnings.push(...(res.warnings ?? []))
    if (res.ok && res.results?.length) {
      result.used = true
      result.results = res.results
      result.provider = res.provider
      result.text = mod.formatSearchResults(res.results, { maxChars: 4000 })
    } else if (!res.ok) {
      result.warnings.push('联网搜索没有取到结果，本次仅依据协议回答。')
    }
  } catch (err) {
    result.warnings.push(`联网搜索失败（${err?.message ?? err}），本次仅依据协议回答。`)
  }
  return result
}

/**
 * 回答一个关于协议的问题。
 *
 * @param {object} input
 * @param {string} input.question
 * @param {Array<object>} input.documents 分析结果数组（或 {id,title,clauses,doc} 形状）
 * @param {boolean} [input.useWeb]
 * @param {object} [opts] { onEvent, signal, ...凭据 }
 * @returns {Promise<object>}
 */
export async function answerQuestion(input, opts = {}) {
  const started = Date.now()
  const warnings = []
  const onEvent = opts.onEvent ?? (() => {})

  const question = clean(input?.question, 500)
  if (!question) {
    throw Object.assign(new Error('请输入你要问的问题。'), { status: 400, code: 'EMPTY_QUESTION' })
  }

  const rt = resolveRuntime({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    modelSummary: opts.modelSummary,
  })

  const extractiveOnly = !rt.hasKey || config.mock
  if (extractiveOnly && !config.mock) {
    throw Object.assign(
      new Error('协议问答需要调用模型。请点右上角「模型设置」填入 DeepSeek API Key。'),
      { status: 400, code: 'NO_API_KEY' },
    )
  }

  // ---------- 1. 准备语料 ----------
  onEvent({ type: 'stage', stage: 'collect', message: '正在整理协议语料…' })

  const rawDocs = Array.isArray(input?.documents) ? input.documents.slice(0, config.askMaxDocs) : []
  const documents = []
  for (const d of rawDocs) {
    // 兼容两种形状：完整的分析结果，或已还原好的 {id,title,clauses}
    const doc = Array.isArray(d?.clauses) && d.clauses[0]?.text !== undefined
      ? { id: d.id, title: d.title, clauses: d.clauses }
      : documentFromResult(d, d?.title)
    if (doc.clauses.length > 0) documents.push(doc)
  }

  if (documents.length === 0) {
    throw Object.assign(new Error('没有可用的协议内容。请先分析至少一份协议，或勾选要纳入的历史记录。'), {
      status: 400,
      code: 'NO_DOCUMENTS',
    })
  }

  // 历史记录为省空间会截断正文，被截掉的那部分条款等于没进语料 ——
  // 必须明确告知，否则用户会以为"协议里没写"，其实是"我们没存下来"。
  const damaged = documents.filter((d) => d.truncated)
  if (damaged.length > 0) {
    const names = damaged.map((d) => `《${d.title}》`).join('')
    const lost = damaged.reduce((n, d) => n + (d.lostClauses ?? 0), 0)
    warnings.push(
      `${names}在历史记录中被截断保存${lost > 0 ? `，约 ${lost} 个条款未能纳入本次问答依据` : ''}。` +
        `建议重新分析这份协议，或把它重新粘贴一次，以获得完整的问答依据。`,
    )
  }

  // ---------- 2. 检索 ----------
  onEvent({ type: 'stage', stage: 'retrieve', message: '正在准备协议全文…' })

  /**
   * 把语料摊平成条款列表（可带字符上限）。
   *
   * 这里的边界处理很关键：**绝不能因为"装不下"就退回空列表**。
   * 早先的写法是"这一条放不下就整个 return"，于是当文档只有一条超长条款时
   * （无编号协议被聚合成一大段，很常见），会直接返回空 ——
   * 上层看到空 passages 就以为"检索不到"，最后变成不回答。
   */
  const flatten = (limit) => {
    const out = []
    let chars = 0
    for (const d of documents) {
      for (const c of d.clauses) {
        const text = String(c.text ?? '')
        if (!text.trim()) continue

        if (limit && chars + text.length > limit) {
          if (out.length > 0) return out
          // 一条都还没装，而这一条自身就超限 → 截断放进，总比空手强
          out.push({
            docId: d.id,
            docTitle: d.title,
            clauseId: c.id,
            heading: c.heading,
            text: text.slice(0, limit),
            score: 0,
            truncated: true,
          })
          return out
        }

        out.push({
          docId: d.id,
          docTitle: d.title,
          clauseId: c.id,
          heading: c.heading,
          text,
          score: 0,
        })
        chars += text.length
      }
    }
    return out
  }

  const corpusChars = documents.reduce((sum, d) => sum + d.clauses.reduce((s2, c) => s2 + c.text.length, 0), 0)
  const budget = config.askWholeDocChars
  const mode = config.askContextMode
  const mustFit = mode === 'full'

  if (mustFit && corpusChars > budget) {
    throw Object.assign(
      new Error(
        `已选择「总是送全文」，但当前知识库有约 ${Math.round(corpusChars / 1000)} 千字，` +
          `超过上限 ${Math.round(budget / 1000)} 千字。请取消勾选部分协议，或调大 ASK_WHOLE_DOC_CHARS，` +
          `或把 ASK_CONTEXT_MODE 改为 auto（放不下时自动改用检索）。`,
      ),
      { status: 400, code: 'CORPUS_TOO_LARGE' },
    )
  }

  // 语料放得下就整篇送 —— 让模型看到全部内容自己判断。
  // 检索只在真的放不下时才介入（此时才需要取舍）。
  const canSendFull = mode !== 'retrieve' && corpusChars <= budget

  let passages
  let retrieval
  let wholeDocument = false
  let relaxedNote = false

  if (canSendFull) {
    passages = flatten(budget)
    wholeDocument = true
    retrieval = { mode: 'full-context', wholeDocument: true, chars: corpusChars, clauses: passages.length }
  } else {
    const index = buildIndex(documents)
    let res = search(index, question, {
      topK: config.askTopK,
      maxChars: config.askMaxChars,
      neighbors: 1,
      mode: 'strict',
    })
    if (res.passages.length === 0) {
      const loose = search(index, question, {
        topK: config.askTopK,
        maxChars: config.askMaxChars,
        neighbors: 1,
        mode: 'loose',
      })
      if (loose.passages.length > 0) res = { passages: loose.passages, stats: { ...loose.stats, relaxed: true } }
    }
    passages = res.passages
    retrieval = res.stats
    relaxedNote = Boolean(res.stats?.relaxed)

    // 关键时刻：检索一无所获时**绝不空手拒答**。
    // 把能装下的部分全部交给模型，让它自己判断 —— 而不是由字面匹配宣布"协议里没写"。
    if (passages.length === 0) {
      const fallback = flatten(budget)
      if (fallback.length > 0) {
        passages = fallback
        wholeDocument = true
        retrieval = {
          mode: 'full-context-partial',
          wholeDocument: true,
          chars: fallback.reduce((n, x) => n + x.text.length, 0),
          clauses: fallback.length,
        }
        warnings.push(
          `知识库约 ${Math.round(corpusChars / 1000)} 千字，超过全文送检上限（${Math.round(budget / 1000)} 千字）；` +
            `同时没能按关键词定位到相关条款。已把前 ${passages.length} 个条款（约 ${Math.round(
              retrieval.chars / 1000,
            )} 千字）交给模型判断 —— 若答案在未送检的部分，可能回答"没找到"。`,
        )
      }
    }
  }

  if (!canSendFull && !wholeDocument) {
    warnings.push(
      `知识库约 ${Math.round(corpusChars / 1000)} 千字，超过全文送检上限（${Math.round(budget / 1000)} 千字），` +
        `因此只送检了与你的问题最相关的 ${passages.length} 个条款。` +
        `如需让模型看到全部内容，可调大 ASK_WHOLE_DOC_CHARS，或减少勾选的协议数量。`,
    )
  }
  if (relaxedNote && !wholeDocument) {
    warnings.push('你的问法与协议用词不太一致，已放宽匹配条件来定位相关条款。')
  }

  // ---------- 3. 可选联网 ----------
  let web = { used: false, results: [], text: '', warnings: [], provider: 'none' }
  if (input?.useWeb) {
    onEvent({ type: 'stage', stage: 'web', message: '正在联网搜索…' })
    web = await maybeWebSearch(question, true, opts.signal)
    warnings.push(...web.warnings)
  }

  // 连"整篇送检"都做不了（协议太长）→ 如实说明，而不是硬猜
  if (passages.length === 0 && !web.used) {
    return {
      question,
      answerable: false,
      answer:
        '没能在协议中定位到与你的问题相关的段落，而协议较长、无法整体送检。可以换个说法再问（尽量用协议里可能出现的词，例如「退款」「数据共享」「自动续费」），或直接在下方原文里搜索。',
      confidence: 'low',
      evidence: [],
      explainers: [],
      caveats: [],
      relatedQuestions: [],
      web: { used: false, results: [], provider: 'none' },
      retrieval,
      wholeDocument: false,
      diagnostics: {
        documents: documents.length,
        clauses: documents.reduce((n, d) => n + d.clauses.length, 0),
        corpusChars,
        budget: config.askWholeDocChars,
        contextMode: config.askContextMode,
        sentClauses: 0,
        sentChars: 0,
        truncatedDocs: documents.filter((d) => d.truncated).length,
      },
      verification: { input: 0, kept: 0, dropped: 0, forcedNotFound: false },
      documents: documents.map((d) => ({ id: d.id, title: d.title, clauses: d.clauses.length })),
      ms: Date.now() - started,
      warnings,
    }
  }

  // ---------- 4a. 离线抽取式回答（无模型可用时） ----------
  //
  // 不生成、不推测，只把检索到的**原文段落**原样摘出来。
  // 这样离线也能用，而且绝对不会编造 —— 因为它根本没有生成能力。
  if (extractiveOnly) {
    const top = passages.slice(0, 3)
    return {
      question,
      answerable: top.length > 0,
      answer:
        top.length > 0
          ? `离线模式下不做生成式回答，这里直接摘出与你的问题最相关的协议原文（共 ${top.length} 段）。请自行阅读判断。`
          : '在这些协议中没有检索到与你的问题相关的内容。',
      confidence: 'low',
      evidence: top.map((p) => ({
        clauseId: p.clauseId,
        clauseHeading: p.heading,
        docId: p.docId,
        docTitle: p.docTitle,
        quote: p.text.trim().slice(0, 400),
        note: '按相关度检索到的原文段落',
        start: 0,
        end: Math.min(p.text.length, 400),
        matchType: 'extractive',
      })),
      explainers: [],
      caveats: [
        '当前是离线抽取模式：只摘录原文，不做解释、不做推理。',
        '在「模型设置」中填入 API Key 后，可获得真正的问答式回答（仍然严格基于协议）。',
      ],
      relatedQuestions: [],
      web: { used: false, results: [], provider: 'none' },
      retrieval,
      wholeDocument,
      diagnostics: {
        documents: documents.length,
        clauses: documents.reduce((n, d) => n + d.clauses.length, 0),
        corpusChars,
        budget: config.askWholeDocChars,
        contextMode: config.askContextMode,
        sentClauses: top.length,
        sentChars: top.reduce((n, p) => n + p.text.length, 0),
        truncatedDocs: documents.filter((d) => d.truncated).length,
      },
      verification: { input: top.length, kept: top.length, dropped: 0, forcedNotFound: false, extractive: true },
      documents: documents.map((d) => ({ id: d.id, title: d.title, clauses: d.clauses.length })),
      ms: Date.now() - started,
      warnings,
      mode: 'extractive',
    }
  }

  // ---------- 4b. 调用模型 ----------
  onEvent({ type: 'stage', stage: 'answer', message: '正在依据协议作答…' })

  const res = await chatJSON({
    messages: [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: buildAskUser({ question, passages, webText: web.used ? web.text : '' }) },
    ],
    model: rt.model,
    auth: rt,
    temperature: 0.1,
    maxTokens: config.maxTokensAsk,
    signal: opts.signal,
    label: 'ask',
  })
  warnings.push(...(res.warnings ?? []))

  const data = res.data ?? {}

  // ---------- 5. 核验依据 ----------
  onEvent({ type: 'stage', stage: 'verify', message: '正在核验回答依据…' })

  const byClause = new Map()
  for (const d of documents) {
    for (const c of d.clauses) byClause.set(`${d.id}|${c.id}`, { doc: d, clause: c })
  }
  // 也允许模型只给 clauseId（单文档场景很常见）
  const byClauseIdOnly = new Map()
  for (const d of documents) {
    for (const c of d.clauses) {
      if (!byClauseIdOnly.has(c.id)) byClauseIdOnly.set(c.id, { doc: d, clause: c })
    }
  }

  const evidence = []
  let dropped = 0
  const seen = new Set()

  for (const raw of Array.isArray(data.evidence) ? data.evidence : []) {
    if (!raw || typeof raw !== 'object') {
      dropped++
      continue
    }
    const quote = clean(raw.quote ?? raw.text ?? raw.snippet, 400)
    if (quote.length < MIN_EVIDENCE_CHARS) {
      dropped++
      continue
    }

    const clauseId = clean(raw.clauseId ?? raw.clause_id ?? raw.id, 40)
    const docId = clean(raw.docId ?? raw.documentId, 60)
    let target = docId ? byClause.get(`${docId}|${clauseId}`) : null
    if (!target) target = byClauseIdOnly.get(clauseId)

    // clauseId 不可信时，用引文在全语料里反查
    if (!target) {
      for (const d of documents) {
        for (const c of d.clauses) {
          if (locateQuote(quote, c.text)) {
            target = { doc: d, clause: c }
            break
          }
        }
        if (target) break
      }
    }
    if (!target) {
      dropped++
      continue
    }

    const located = locateQuote(quote, target.clause.text)
    if (!located) {
      // 核验不通过 → 丢弃这条依据（防编造）
      dropped++
      continue
    }

    const key = `${target.doc.id}|${target.clause.id}|${quote.slice(0, 40)}`
    if (seen.has(key)) {
      dropped++
      continue
    }
    seen.add(key)

    // 展示用的引文以原文切片为准，保证「看到的」与「定位到的」一致
    const sourceSlice = target.clause.text.slice(located.start, located.end).trim()

    evidence.push({
      clauseId: target.clause.id,
      clauseHeading: target.clause.heading,
      docId: target.doc.id,
      docTitle: target.doc.title,
      quote: sourceSlice || quote,
      note: clean(raw.note ?? raw.explain, 120),
      start: located.start,
      end: located.end,
      matchType: located.matchType,
    })
    if (evidence.length >= 8) break
  }

  // ---------- 6. 反幻觉裁决 ----------
  let answerable = data.answerable !== false
  let answer = clean(data.answer, 800)
  let confidence = normalizeConfidence(data.confidence)
  let forcedNotFound = false

  if (answerable && evidence.length === 0) {
    // 模型声称有依据，但一条都核验不过 → 一律改判。这是本产品最重要的防线。
    answerable = false
    forcedNotFound = true
    confidence = 'low'
    answer =
      answer ||
      ''
    answer = '模型给出的回答无法在协议原文中核验，为避免误导，这里不展示该结论。请换一种问法，或直接查阅下方的协议原文。'
    warnings.push('模型的回答未能通过原文核验（引文无法定位），已按「未找到依据」处理。')
  }

  if (!answerable && !answer) {
    answer = '这些协议中没有找到与你的问题直接相关的规定。'
  }

  const explainers = (Array.isArray(data.explainers) ? data.explainers : [])
    .map((x) => clean(x, 240))
    .filter(Boolean)
    .slice(0, 2)

  const caveats = (Array.isArray(data.caveats) ? data.caveats : [])
    .map((c) => clean(c, 200))
    .filter(Boolean)
    .slice(0, 4)

  if (web.used) {
    caveats.push('本次回答包含联网搜索结果，那部分属于外部信息，与协议本身无关，请自行核实。')
  }

  const relatedQuestions = (Array.isArray(data.relatedQuestions) ? data.relatedQuestions : [])
    .map((q) => clean(q, 60))
    .filter(Boolean)
    .slice(0, 3)

  if (dropped > 0) {
    warnings.push(`${dropped} 条依据因无法在协议原文中定位而被丢弃。`)
  }

  return {
    question,
    answerable,
    answer,
    confidence,
    evidence,
    /** 内部状态快照：出问题时用户一眼能看出卡在哪一环 */
    diagnostics: {
      documents: documents.length,
      clauses: documents.reduce((n, d) => n + d.clauses.length, 0),
      corpusChars,
      budget: config.askWholeDocChars,
      contextMode: config.askContextMode,
      sentClauses: passages.length,
      sentChars: passages.reduce((n, p) => n + p.text.length, 0),
      truncatedDocs: documents.filter((d) => d.truncated).length,
    },
    explainers,
    caveats,
    relatedQuestions,
    web: {
      used: web.used,
      provider: web.provider,
      results: web.results,
      warnings: web.warnings,
    },
    retrieval,
    wholeDocument,
    verification: {
      input: Array.isArray(data.evidence) ? data.evidence.length : 0,
      kept: evidence.length,
      dropped,
      forcedNotFound,
    },
    documents: documents.map((d) => ({ id: d.id, title: d.title, clauses: d.clauses.length })),
    usage: res.usage,
    model: res.model,
    ms: Date.now() - started,
    warnings,
  }
}
