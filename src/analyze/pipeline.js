/**
 * 分析流水线（Orchestrator）。
 *
 * 全流程：
 *   归一化 → 条款切分 → 本地预扫描 → 分片 MAP（并发调用模型，逐条标注）
 *   → 引文核验（本地） → REDUCE（全局汇总） → 风险分校准 → 组装结果
 *
 * 设计要点：
 *  - 分片并行：长协议切成多个批次并发分析，既降低单次上下文压力，也缩短总耗时。
 *  - 局部失败不影响整体：某个批次失败只记警告，其余结果照常合并。
 *  - 全部失败 → 自动降级到本地启发式，用户始终能拿到一份结果。
 *  - 全程通过 onEvent 回调上报进度，供 SSE 推送到前端。
 */
import { config, resolveRuntime, redactSecrets } from '../config.js'
import { randomId } from '../ids.js'
import { normalizeText } from '../normalize.js'
import { segmentClauses } from '../segment.js'
import { asArray } from './json.js'
import { chatJSON } from './client.js'
import { MAP_SYSTEM, buildMapUser, REDUCE_SYSTEM, buildReduceUser, emptyReduceResult } from './prompts.js'
import { verifyFindings, verifyClauseNotes, normalizeInteractions } from './verify.js'
import {
  heuristicFindings,
  heuristicReport,
  heuristicClauseNotes,
  heuristicInteractions,
  computeRiskScore,
  HEURISTIC_WARNINGS,
} from './heuristic.js'
import { prescan } from './taxonomy.js'

/** 单条条款送入模型时的字符上限，防止个别超长条款撑爆上下文 */
const MAX_CLAUSE_CHARS_FOR_MODEL = 12_000

function noop() {}

/** 有限并发执行池 */
async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const idx = cursor++
      if (idx >= items.length) return
      results[idx] = await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
  return results
}

/** 把条款按字符预算打包成批次 */
export function batchClauses(clauses, chunkChars) {
  const batches = []
  let cur = []
  let curChars = 0
  for (const c of clauses) {
    if (cur.length > 0 && curChars + c.text.length > chunkChars) {
      batches.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(c)
    curChars += c.text.length
  }
  if (cur.length) batches.push(cur)
  return batches
}

/**
 * 主入口。
 *
 * @param {{ text:string, title?:string, source?:object, extraction?:object }} input
 * @param {{ onEvent?:(e:object)=>void, signal?:AbortSignal }} [opts]
 * @returns {Promise<object>} 完整分析结果（可直接 JSON 序列化返回前端）
 */
export async function analyzeDocument(input, opts = {}) {
  const onEvent = opts.onEvent ?? noop
  const signal = opts.signal
  const started = Date.now()
  const warnings = []

  const emit = (stage, message, extra = {}) => onEvent({ type: 'stage', stage, message, ...extra })

  // ---------- 1. 归一化 ----------
  emit('normalize', '正在清理与归一化文本…')
  const { text, stats: normStats } = normalizeText(input.text ?? '')
  if (!text.trim()) {
    throw Object.assign(new Error('没有可分析的文本内容。'), { status: 400, code: 'EMPTY_TEXT' })
  }
  if (text.length > config.maxTextChars) {
    warnings.push(`文本超过 ${config.maxTextChars} 字，已截断分析（原长 ${text.length} 字）。`)
  }
  const analyzedText = text.length > config.maxTextChars ? text.slice(0, config.maxTextChars) : text

  // ---------- 2. 条款切分 ----------
  emit('segment', '正在识别协议结构与条款…')
  const { clauses, stats: segStats } = segmentClauses(analyzedText)
  if (clauses.length === 0) {
    throw Object.assign(new Error('文本切分后没有可用条款。'), { status: 400, code: 'NO_CLAUSES' })
  }

  const clauseById = new Map(clauses.map((c) => [c.id, c]))
  const clauseIndex = clauses.map((c) => ({
    id: c.id,
    index: c.index,
    heading: c.heading,
    start: c.start,
    end: c.end,
    chars: c.chars,
    headingRule: c.headingRule,
  }))

  const docStats = { clauseCount: clauses.length, totalChars: analyzedText.length, title: input.title }
  const docMeta = {
    title: input.title || '未命名协议',
    chars: analyzedText.length,
    originalChars: normStats.inputChars,
    clauseCount: clauses.length,
    segmentStrategy: segStats.strategy,
    headingRules: segStats.headingRules,
  }

  // ---------- 3. 本地预扫描 ----------
  emit('prescan', '正在进行本地规则预扫描…')
  const prescanHits = prescan(clauses).map((h) => ({
    clauseId: h.clauseId,
    category: h.category,
    severity: h.severity,
    matches: h.matches,
  }))

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const addUsage = (u) => {
    usage.prompt_tokens += u?.prompt_tokens ?? 0
    usage.completion_tokens += u?.completion_tokens ?? 0
    usage.total_tokens += u?.total_tokens ?? 0
  }

  let rawFindings = []
  let rawNotes = []
  let mapCalls = 0

  // 本次分析实际使用的凭据：请求携带的优先于服务端环境变量。
  // 服务端不保存用户密钥，凭据只在这一次请求的生命周期内存在。
  const rt = resolveRuntime({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    modelSummary: opts.modelSummary,
  })

  // 模式判定：请求显式指定 > 全局 mock > 无可用 Key 时自动降级
  const requestedMode = opts.mode ?? 'auto'

  if (requestedMode === 'llm' && !rt.hasKey && !config.mock) {
    throw Object.assign(
      new Error('你选择了「模型分析」，但还没有配置 API Key。请点右上角「模型设置」填入 DeepSeek API Key。'),
      { status: 400, code: 'NO_API_KEY' },
    )
  }

  const forcedHeuristic = requestedMode === 'heuristic' || config.mock || !rt.hasKey
  let mode = forcedHeuristic ? 'heuristic' : 'llm'

  if (forcedHeuristic) {
    if (requestedMode === 'heuristic') {
      warnings.push('按请求使用了本地规则模式（未调用模型）。')
    } else if (!rt.hasKey && !config.mock) {
      warnings.push('未检测到 API Key，已自动使用本地规则模式。在右上角「模型设置」中填入 Key 可获得明显更准确的分析。')
    }
    warnings.push(...HEURISTIC_WARNINGS)
  }

  // ---------- 4. MAP ----------
  if (forcedHeuristic) {
    emit('map', '使用本地规则分析条款…')
  } else {
    const batches = batchClauses(clauses, config.chunkChars)
    emit('map', `正在逐条审查 ${clauses.length} 个条款（分 ${batches.length} 批并发分析）…`, {
      done: 0,
      total: batches.length,
    })

    let completed = 0
    const batchResults = await pool(batches, config.concurrency, async (batch) => {
      if (signal?.aborted) return { ok: false, error: '已取消' }
      const payload = batch.map((c) => ({
        id: c.id,
        heading: c.heading,
        text: c.text.length > MAX_CLAUSE_CHARS_FOR_MODEL ? c.text.slice(0, MAX_CLAUSE_CHARS_FOR_MODEL) : c.text,
      }))
      try {
        const res = await chatJSON({
          messages: [
            { role: 'system', content: MAP_SYSTEM },
            { role: 'user', content: buildMapUser(payload, { docTitle: docMeta.title, prescanHints: prescanHits }) },
          ],
          model: rt.model,
          auth: rt,
          temperature: 0.1,
          maxTokens: config.maxTokensMap,
          signal,
          salvageKey: 'findings',
          label: 'map',
        })
        addUsage(res.usage)
        mapCalls++
        return {
          ok: true,
          findings: asArray(res.data?.findings),
          notes: asArray(res.data?.clauseNotes),
          warnings: res.warnings,
        }
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err), aborted: signal?.aborted }
      } finally {
        completed++
        emit('map', `已完成 ${completed}/${batches.length} 批`, { done: completed, total: batches.length })
      }
    })

    if (signal?.aborted) {
      throw Object.assign(new Error('分析已取消'), { status: 499, code: 'ABORTED' })
    }

    const failures = []
    for (const r of batchResults) {
      if (r?.ok) {
        rawFindings.push(...r.findings)
        rawNotes.push(...(r.notes ?? []))
        warnings.push(...(r.warnings ?? []))
      } else {
        failures.push(r?.error ?? '未知错误')
      }
    }

    if (failures.length) {
      warnings.push(`${failures.length}/${batchResults.length} 个批次分析失败，结果可能不完整：${failures[0]}`)
    }

    // 全部失败 → 降级到本地启发式
    if (mapCalls === 0) {
      mode = 'heuristic'
      emit('map', '模型调用全部失败，已降级为本地规则分析…')
      warnings.push('模型调用失败，已自动降级为本地关键词规则分析。')
      warnings.push(...HEURISTIC_WARNINGS)
      rawFindings = []
      rawNotes = []
    }
  }

  // ---------- 5. 核验 ----------
  emit('verify', '正在核验引文并定位原文…')
  let findings
  let clauseNotes
  let verifyStats
  let noteStats
  if (mode === 'heuristic') {
    findings = heuristicFindings(clauses)
    clauseNotes = heuristicClauseNotes(clauses, findings)
    verifyStats = { input: findings.length, kept: findings.length, dropped: 0, droppedNoQuote: 0, fuzzy: 0, crossClause: 0 }
    noteStats = { input: clauseNotes.length, kept: clauseNotes.length, dropped: 0 }
  } else {
    const verified = verifyFindings(rawFindings, clauseById, { docText: analyzedText })
    findings = verified.findings
    verifyStats = verified.stats
    if (verifyStats.dropped > 0) {
      warnings.push(`${verifyStats.dropped} 条结论因引文无法在原文中定位而被丢弃（已防止模型编造条款）。`)
    }
    const verifiedNotes = verifyClauseNotes(rawNotes, clauseById)
    clauseNotes = verifiedNotes.notes
    noteStats = verifiedNotes.stats
    if (clauseNotes.length === 0 && clauses.length > 0) {
      warnings.push('本次没有生成条款解读（模型未返回或返回内容无法对应到条款）。')
    }
  }

  // ---------- 6. REDUCE ----------
  emit('reduce', '正在生成整体评估…')
  let report
  const computedScore = computeRiskScore(findings)

  if (mode === 'heuristic') {
    report = heuristicReport(findings, docStats)
  } else if (findings.length === 0) {
    report = { ...emptyReduceResult(), computedScore }
  } else {
    // 汇总阶段的多级降级：汇总模型 → 逐条模型 → 本地统计。
    // 逐条模型通常更快更稳，拿它兜底远好于直接退化成关键词统计
    // （后者会丢掉所有模型生成的解释与建议，报告质量下降明显）。
    const reduceMessages = [
      { role: 'system', content: REDUCE_SYSTEM },
      { role: 'user', content: buildReduceUser({ docTitle: docMeta.title, findings, docStats }) },
    ]
    const candidates = [{ model: rt.modelSummary, note: '汇总模型' }]
    if (rt.model && rt.model !== rt.modelSummary) {
      candidates.push({ model: rt.model, note: '逐条模型（降级）' })
    }

    let succeeded = false
    for (let i = 0; i < candidates.length && !succeeded; i++) {
      const cand = candidates[i]
      try {
        const res = await chatJSON({
          messages: reduceMessages,
          model: cand.model,
          auth: rt,
          temperature: 0.2,
          maxTokens: config.maxTokensSummary,
          signal,
          label: 'reduce',
        })
        addUsage(res.usage)
        warnings.push(...(res.warnings ?? []))
        report = { ...res.data, computedScore }
        succeeded = true
        if (i > 0) {
          warnings.push(`汇总模型（${rt.modelSummary}）失败，已降级到逐条模型（${cand.model}）生成整体评估。`)
        }
      } catch (err) {
        const msg = redactSecrets(err?.message ?? String(err))
        if (i < candidates.length - 1) {
          warnings.push(`${cand.note}（${cand.model}）汇总失败，正在尝试下一个模型：${msg}`)
        } else {
          warnings.push(`汇总阶段失败，已使用本地统计生成报告：${msg}`)
        }
      }
    }
    if (!succeeded) report = heuristicReport(findings, docStats)
  }

  // 风险分校准：模型给分与本地加权分差距过大时向本地分靠拢，避免明显失真
  report = normalizeReport(report, findings, computedScore, warnings)

  // 跨条款联系：clauseIds 必须真实存在且至少两个
  const validClauseIds = new Set(clauses.map((c) => c.id))
  if (mode === 'heuristic') {
    // 规则模式没有模型可判断条款关系，改用已知的组合模式（宁少不编）
    report.interactions = heuristicInteractions(findings)
  } else {
    report.interactions = normalizeInteractions(report.interactions, validClauseIds)
  }

  const result = {
    id: randomId(),
    createdAt: new Date().toISOString(),
    source: input.source ?? { type: 'text' },
    extraction: input.extraction ?? null,
    doc: { ...docMeta, text: analyzedText },
    clauses: clauseIndex,
    findings,
    clauseNotes,
    report,
    stats: {
      mode,
      ms: Date.now() - started,
      mapCalls,
      batches: mode === 'llm' ? batchClauses(clauses, config.chunkChars).length : 0,
      prescanHits: prescanHits.length,
      verify: verifyStats,
      notes: noteStats,
      interactions: report.interactions.length,
      usage,
      model: mode === 'llm' ? rt.model : null,
      modelSummary: mode === 'llm' ? rt.modelSummary : null,
      // 只记录密钥来源，绝不记录密钥本身
      keySource: mode === 'llm' ? rt.keySource : 'none',
    },
    warnings: [...new Set(warnings)],
  }

  emit('done', '分析完成', { resultId: result.id })
  return result
}

/** 规整模型给出的汇总，防止缺字段/越界/幻觉引用 */
function normalizeReport(report, findings, computedScore, warnings) {
  const r = { ...(report ?? {}) }

  let score = Number(r.riskScore ?? r.risk_score ?? r.score)
  if (!Number.isFinite(score)) {
    score = computedScore
  }
  score = Math.max(0, Math.min(100, Math.round(score)))

  // 与本地加权分差异过大时靠拢，避免「10 条严重条款却给 5 分」这类失真
  if (findings.length > 0 && Math.abs(score - computedScore) > 40) {
    const blended = Math.round(score * 0.5 + computedScore * 0.5)
    warnings.push(`模型给出的风险分（${score}）与条款加权分（${computedScore}）差异较大，已按权重校准为 ${blended}。`)
    score = blended
  }

  const validClauseIds = new Set(findings.map((f) => f.clauseId))
  const topConcerns = (Array.isArray(r.topConcerns) ? r.topConcerns : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      clauseId: validClauseIds.has(c.clauseId) ? c.clauseId : null,
      title: String(c.title ?? '').slice(0, 40),
      severity: String(c.severity ?? 'medium'),
      why: String(c.why ?? c.reason ?? '').slice(0, 200),
    }))
    .slice(0, 5)

  const strArr = (v, max = 6, len = 200) =>
    (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.slice(0, len)).slice(0, max)

  return {
    riskScore: score,
    verdict: String(r.verdict ?? '').slice(0, 60) || '已完成分析',
    summary: String(r.summary ?? '').slice(0, 1200),
    topConcerns,
    categorySummary: (Array.isArray(r.categorySummary) ? r.categorySummary : [])
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        category: String(c.category ?? 'other'),
        severity: String(c.severity ?? 'medium'),
        count: Number.isFinite(Number(c.count)) ? Number(c.count) : 0,
        note: String(c.note ?? '').slice(0, 120),
      }))
      .slice(0, 30),
    positives: strArr(r.positives, 6),
    actions: strArr(r.actions, 6),
    readability: String(r.readability ?? '').slice(0, 400),
    // interactions 由调用方在拿到全部条款后归一化（需要校验 clauseId 真实性）
    interactions: Array.isArray(r.interactions) ? r.interactions : [],
    computedScore,
  }
}
