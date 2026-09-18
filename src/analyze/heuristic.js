/**
 * 本地启发式分析（Heuristic mode）。
 *
 * 三个用途：
 *   1. 离线 Mock：没有 API Key 也能完整跑通整条链路，便于开发与演示。
 *   2. 降级兜底：API 不可用、限流或超时导致全部失败时，仍然给出一份基于规则的结果。
 *   3. 线索增强：把规则命中的条款作为 hint 喂给模型，提升召回。
 *
 * 局限必须对用户诚实说明：规则只能发现「措辞上明显」的问题，无法理解上下文，
 * 误报与漏报都明显高于模型分析。因此结果里会带 `mode: 'heuristic'` 与警告。
 */
import { CATEGORIES, CATEGORY_BY_ID, SEVERITY_WEIGHT, prescan } from './taxonomy.js'

/**
 * 在文本中截取包含某片段的完整句子作为引文。
 *
 * `atIndex` 必须是该片段在 text 中的真实偏移。这一点很关键：
 * 关键词可能同时出现在标题和正文里（例如标题「第五条 费用与自动续费」），
 * 若用 indexOf 反查会命中标题，导致引文变成标题而不是真正的条款内容。
 *
 * @returns {{ text:string, start:number }} start 为 -1 表示无法定位
 */
function sentenceAround(text, fragment, atIndex, maxLen = 180) {
  const idx = Number.isInteger(atIndex) && atIndex >= 0 ? atIndex : text.indexOf(fragment)
  if (idx === -1 || idx >= text.length) return { text: fragment.slice(0, maxLen), start: -1 }

  const BOUNDARY = /[。！？；\n]|[.!?;]\s/
  let start = 0
  for (let i = idx; i >= 0; i--) {
    if (BOUNDARY.test(text[i])) {
      start = i + 1
      break
    }
  }
  let end = text.length
  const scanFrom = Math.min(idx + Math.max(fragment.length, 1), text.length)
  for (let i = scanFrom; i < text.length; i++) {
    if (BOUNDARY.test(text[i])) {
      end = i + 1
      break
    }
  }

  let s = text.slice(start, end)
  const lead = s.length - s.trimStart().length
  s = s.trim()
  let quoteStart = start + lead

  if (s.length > maxLen) {
    // 保证命中的片段仍在窗口内
    const rel = idx - quoteStart
    if (rel > 0 && rel + fragment.length > maxLen) {
      // 片段在窗口之外：以片段为中心截取
      const from = Math.max(0, rel - 20)
      s = s.slice(from, from + maxLen)
      quoteStart += from
    } else {
      s = s.slice(0, maxLen)
    }
  }
  return { text: s.trim(), start: quoteStart }
}

const CATEGORY_ADVICE = {
  unilateral_change: '定期回看协议更新记录，重大变更前留存旧版本。',
  arbitration: '评估维权成本；如有异议可在签约前提出。',
  class_action_waiver: '注意你只能单独主张权利，小额损失实际难以追偿。',
  data_sharing: '在隐私设置中关闭个性化推荐与第三方共享。',
  liability_disclaimer: '重要数据自行备份，不要依赖平台的可用性承诺。',
  indemnity: '避免上传可能侵权的第三方内容。',
  auto_renewal: '开通后立刻在支付渠道或账号设置中关闭自动续费。',
  refund: '付费前确认退款规则，优先选择可按月付费。',
  content_license: '谨慎上传原创作品；必要时先在其他平台留证。',
  ip_ownership: '确认你的创作成果归属，必要时另行书面约定。',
  feedback_license: '无需特别处理，了解即可。',
  account_termination: '定期导出自己的数据与内容，不要只存在云端。',
  service_change: '不要把该服务作为唯一依赖，准备替代方案。',
  unilateral_interpretation: '此类条款在国内消费者合同中常被认定无效，可主张权利。',
  privacy_tracking: '使用浏览器隐私模式、清理 Cookie 或限制广告追踪。',
  data_retention: '注销账号前先导出数据，并书面要求删除。',
  sensitive_data: '谨慎提供生物识别、金融账户等敏感信息。',
  minor_consent: '如为未成年人使用，请监护人确认并开启青少年模式。',
  user_content_responsibility: '确保上传内容拥有合法授权。',
  notice_method: '定期查收注册邮箱与站内通知，避免错过变更。',
  assignment: '了解你的合同相对方可能变更。',
  third_party_service: '点击第三方链接前确认其隐私政策。',
  governing_law: '了解适用法律与你的所在地是否一致。',
  service_availability: '付费前确认是否有服务可用性承诺。',
  export_control: '常规合规条款，了解即可。',
  force_majeure: '常规条款，了解即可。',
  other: '建议仔细阅读该条款原文。',
}

/**
 * 依据本地规则生成发现列表。
 * @param {Array<{id:string,heading:string,text:string,start:number,end:number}>} clauses
 * @returns {Array<object>} 与 verify.js 输出同构的 findings（含精确偏移）
 */
export function heuristicFindings(clauses) {
  const hits = prescan(clauses)
  const byId = new Map(clauses.map((c) => [c.id, c]))
  const findings = []
  const seen = new Set()

  for (const hit of hits) {
    const clause = byId.get(hit.clauseId)
    if (!clause) continue
    const cat = CATEGORY_BY_ID.get(hit.category)
    if (!cat) continue

    const matchText = hit.matches[0] ?? ''
    let atIndex = hit.matchIndexes?.[0] ?? -1

    // 若关键词命中落在标题行内（例如标题就叫「第五条 费用与自动续费」），
    // 优先改取正文中的下一次出现，否则引文会变成标题而非真正的问题条款。
    const firstNl = clause.text.indexOf('\n')
    if (matchText && firstNl !== -1 && atIndex >= 0 && atIndex < firstNl) {
      const next = clause.text.indexOf(matchText, firstNl + 1)
      if (next !== -1) atIndex = next
    }

    const located = sentenceAround(clause.text, matchText, atIndex)
    const quote = located.text
    const key = `${clause.id}|${cat.id}|${quote.slice(0, 40)}`
    if (seen.has(key)) continue
    seen.add(key)

    // 使用句级定位得到的真实偏移，而不是 indexOf 反查（避免命中标题里的重复词）
    const start = located.start >= 0 ? clause.start + located.start : clause.start
    const end = located.start >= 0 ? start + quote.length : clause.end

    findings.push({
      clauseId: clause.id,
      clauseHeading: clause.heading,
      category: cat.id,
      severity: cat.baseline,
      quote,
      title: cat.label,
      explanation: cat.what,
      impact: cat.why,
      advice: CATEGORY_ADVICE[cat.id] ?? '建议阅读原文确认。',
      // 规则模式给不出「隐藏坑点」判断，如实标 false，不假装能判断
      hidden: false,
      // 但可以给出**真实命中**的字眼（来自正则匹配，不是猜的）
      wording: (hit.matches ?? []).filter(Boolean).slice(0, 3),
      start,
      end,
      matchType: located.start >= 0 ? 'exact' : 'clause',
      crossClause: false,
      verified: true,
      detectedBy: 'rule',
    })
  }

  const ORDER = ['critical', 'high', 'medium', 'low', 'info']
  findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.start - b.start)
  findings.forEach((f, i) => {
    f.id = `f${i + 1}`
  })
  return findings
}

/** 由发现列表推导风险分（0-100，饱和函数避免线性爆炸） */
export function computeRiskScore(findings) {
  const raw = findings.reduce((sum, f) => sum + (SEVERITY_WEIGHT[f.severity] ?? 0), 0)
  if (raw === 0) return 0
  return Math.round(100 * (1 - Math.exp(-raw / 70)))
}

function verdictFor(score) {
  if (score <= 20) return '整体较为常规'
  if (score <= 45) return '有需要注意的条款'
  if (score <= 70) return '存在多项明显不利条款'
  return '存在严重风险条款'
}

/**
 * 生成启发式汇总报告（与 REDUCE 阶段输出同构）。
 * @param {Array<object>} findings
 * @param {{ clauseCount:number, totalChars:number, title?:string }} docStats
 */
export function heuristicReport(findings, docStats) {
  const score = computeRiskScore(findings)

  const byCat = new Map()
  for (const f of findings) {
    const cur = byCat.get(f.category) ?? { category: f.category, severity: f.severity, count: 0 }
    cur.count++
    const ORDER = ['critical', 'high', 'medium', 'low', 'info']
    if (ORDER.indexOf(f.severity) < ORDER.indexOf(cur.severity)) cur.severity = f.severity
    byCat.set(f.category, cur)
  }

  const categorySummary = [...byCat.values()]
    .sort((a, b) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(b.severity))
    .map((c) => ({
      ...c,
      note: CATEGORY_BY_ID.get(c.category)?.what?.slice(0, 60) ?? '',
    }))

  const topConcerns = findings.slice(0, 5).map((f) => ({
    clauseId: f.clauseId,
    title: f.title,
    severity: f.severity,
    why: f.impact || f.explanation,
  }))

  const critical = findings.filter((f) => f.severity === 'critical').length
  const high = findings.filter((f) => f.severity === 'high').length

  const summary =
    findings.length === 0
      ? `本地规则扫描未在约 ${docStats.totalChars} 字的协议中发现明显的红旗措辞。这并不等于协议没有问题——规则只能识别固定措辞，建议同时用模型分析以获得更全面的判断。`
      : `本地规则在 ${docStats.clauseCount} 个条款中命中 ${findings.length} 处可疑表述，其中严重 ${critical} 条、高 ${high} 条，整体风险分 ${score}。问题主要集中在${categorySummary
          .slice(0, 3)
          .map((c) => CATEGORY_BY_ID.get(c.category)?.label ?? c.category)
          .join('、')}等方面。由于该结果由关键词规则生成，可能存在误报，请结合原文自行确认。`

  return {
    riskScore: score,
    verdict: verdictFor(score),
    summary,
    topConcerns,
    categorySummary,
    positives: [],
    actions: [...new Set(findings.map((f) => f.advice).filter(Boolean))].slice(0, 5),
    readability: '由本地规则生成，未评估表述清晰度。',
    computedScore: score,
  }
}

export const HEURISTIC_WARNINGS = [
  '本次结果由本地关键词规则生成（未调用模型或模型调用失败），可能存在误报与漏报，仅供参考。',
]


/**
 * 本地规则模式下的条款解读（降级版）。
 *
 * 规则引擎读不懂语义，所以这里**不假装能解释**：只给出这条在讲什么的结构化提示，
 * 并如实标注语气来源。宁可信息少，也不要编造一段看着像解读、实际是幻觉的文字。
 *
 * @param {Array<{id:string,heading:string,text:string}>} clauses
 * @param {Array<{clauseId:string,severity:string}>} findings
 */
export function heuristicClauseNotes(clauses, findings) {
  const severityByClause = new Map()
  const ORDER = ['critical', 'high', 'medium', 'low', 'info']
  for (const f of findings) {
    const cur = severityByClause.get(f.clauseId)
    if (!cur || ORDER.indexOf(f.severity) < ORDER.indexOf(cur)) severityByClause.set(f.clauseId, f.severity)
  }

  const notes = []
  for (const c of clauses) {
    // 太短的条款（标题行、页码残留）不值得单独解读
    if ((c.text ?? '').trim().length < 20) continue

    const body = c.text.replace(/\s+/g, ' ').trim()
    // 标题本身就是最好的「一句话概括」，优先用它
    let plain = (c.heading ?? '').replace(/\s+/g, ' ').trim()
    if (!plain || plain.length < 4) {
      const firstSentence = body.split(/(?<=[。！？；.!?;])/)[0] ?? body
      plain = firstSentence
    }
    if (plain.length > 40) plain = `${plain.slice(0, 40)}…`

    const sev = severityByClause.get(c.id)
    const tone = sev === 'critical' || sev === 'high' ? 'unfavorable' : sev ? 'mixed' : 'neutral'

    notes.push({
      id: `n${notes.length + 1}`,
      clauseId: c.id,
      clauseHeading: c.heading,
      plain,
      meaning:
        '本地规则模式只能定位关键词，无法解释条款含义。如需逐条解读，请在「模型设置」中配置 API Key 后重新分析。',
      keyPoints: [],
      tone,
      degraded: true,
    })
    if (notes.length >= 60) break
  }
  return notes
}


/**
 * 规则模式下的「跨条款联系」。
 *
 * 规则引擎无法真正理解条款间的关系，所以这里只覆盖**几组公认的、由条款文字
 * 就能确定的组合效应**，并且明确标注来源为规则。宁可少给，也不要编造关系。
 */
const INTERACTION_RULES = [
  {
    needs: ['content_license', 'account_termination'],
    severity: 'high',
    title: '内容授权 + 账号终止',
    explanation:
      '内容授权条款通常约定「永久、不可撤销」，而账号终止条款允许平台随时封禁账号。两者合起来意味着：即使你被踢出平台，你发布的内容依然被对方永久授权使用。',
    scenario: '被误封账号后想撤回内容，但授权是不可撤销的，无从主张。',
  },
  {
    needs: ['unilateral_change', 'liability_disclaimer'],
    severity: 'high',
    title: '单方变更 + 免责',
    explanation:
      '平台可以随时改协议，同时又对服务中断、数据丢失免责。两条叠加意味着规则随时可变，而改变带来的后果由你承担。',
    scenario: '平台改版导致你的数据丢失，但免责条款挡住了追责。',
  },
  {
    needs: ['data_sharing', 'privacy_tracking'],
    severity: 'high',
    title: '数据共享 + 跨设备追踪',
    explanation:
      '既能跨设备追踪你的行为，又能把这些信息共享给关联方和合作伙伴。合起来就是一套完整的用户画像与商业化链条。',
    scenario: '你在 A 设备的搜索行为，最终变成了另一家公司投放给你的广告。',
  },
  {
    needs: ['data_retention', 'account_termination'],
    severity: 'medium',
    title: '数据保留 + 账号终止',
    explanation:
      '一边给了你注销账号的权利，另一边又规定注销后仍会被保留必要信息。这实际上架空了删除权。',
    scenario: '注销账号后，你的数据仍在对方服务器上。',
  },
  {
    needs: ['arbitration', 'liability_disclaimer'],
    severity: 'high',
    title: '强制仲裁 + 免责',
    explanation:
      '争议必须去指定的仲裁机构，且对方已广泛免责。这意味着维权成本高、可主张的空间又小，实际上很难获得救济。',
    scenario: '服务出问题造成损失，但你既难以起诉，对方又基本免责。',
  },
  {
    needs: ['auto_renewal', 'refund'],
    severity: 'medium',
    title: '自动续费 + 不予退款',
    explanation:
      '到期自动扣费，且费用一经支付不予退还。忘记取消就会持续失血，且无法追回。',
    scenario: '忘记取消订阅，连续被扣了几个月才发现。',
  },
  {
    needs: ['content_license', 'ip_ownership'],
    severity: 'medium',
    title: '内容授权 + 知识产权归属',
    explanation: '一边约定你的内容权利归平台，一边又要求你授予永久免费许可。两条合起来，你的创作基本不再属于你。',
    scenario: '你上传的原创作品被平台商用，且无法要求分成或下架。',
  },
]

export function heuristicInteractions(findings) {
  const present = new Set(findings.map((f) => f.category))
  const out = []
  for (const rule of INTERACTION_RULES) {
    if (!rule.needs.every((c) => present.has(c))) continue
    const ids = []
    for (const cat of rule.needs) {
      const f = findings.find((x) => x.category === cat)
      if (f) ids.push(f.clauseId)
    }
    if (ids.length < 2) continue
    out.push({
      id: `x${out.length + 1}`,
      clauseIds: [...new Set(ids)],
      severity: rule.severity,
      title: rule.title,
      explanation: rule.explanation,
      scenario: rule.scenario,
      detectedBy: 'rule',
    })
  }
  return out
}
