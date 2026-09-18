/**
 * 结果渲染。
 *
 * 三条设计主线：
 *  1. **可核对**：每条结论都能点回原文，原文里的高亮也能点回结论，双向定位。
 *  2. **可筛选**：条款多的时候，按等级/关键词收敛，避免信息过载。
 *  3. **不撒谎**：分析模式（模型 / 本地规则）、警告、弃用条目数都明确展示。
 */
import { escapeHtml, formatDate, formatDuration, formatNumber, scoreColor, debounce } from './util.js'

const RING_CIRCUMFERENCE = 2 * Math.PI * 52
/** 原文渲染上限：超过这个长度会明显拖慢页面 */
const MAX_RENDER_CHARS = 400_000

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

/**
 * 建立结果视图。
 * @param {Record<string, HTMLElement>} dom
 * @param {{categories:Array, severityLabels:Record<string,string>}} taxonomy
 * @param {{ onLocate?:(finding:object)=>void }} [handlers]
 */
export function createResultView(dom, taxonomy, handlers = {}) {
  let result = null
  /** @type {{severity:string, search:string, hiddenOnly:boolean}} */
  const filters = { severity: 'all', search: '', hiddenOnly: false }
  let activeFindingId = null
  let markIndex = new Map() // findingId -> mark 元素
  let itemIndex = new Map() // findingId -> list item 元素

  const categoryById = new Map((taxonomy?.categories ?? []).map((c) => [c.id, c]))
  const severityLabels = taxonomy?.severityLabels ?? {}

  const categoryLabel = (id) => categoryById.get(id)?.label ?? id
  const severityLabel = (s) => severityLabels[s] ?? s

  // ---------- 原文高亮 ----------

  /**
   * 把正文与风险区间合并成带 <mark> 的 HTML。
   * 相邻/重叠的区间会合并成一个 mark，并记录它承载的所有 finding id，
   * 这样即使两条结论落在同一句话上，点击高亮也能知道关联了哪些结论。
   */
  function buildHighlighted(text, findings) {
    const valid = findings
      .filter(
        (f) =>
          Number.isInteger(f.start) &&
          Number.isInteger(f.end) &&
          f.end > f.start &&
          f.start >= 0 &&
          f.end <= text.length,
      )
      .sort((a, b) => a.start - b.start || a.end - b.end)

    if (valid.length === 0) return escapeHtml(text)

    const groups = []
    for (const f of valid) {
      const last = groups[groups.length - 1]
      if (last && f.start < last.end) {
        last.end = Math.max(last.end, f.end)
        last.ids.push(f.id)
        // 合并时取更严重的等级作为配色
        if (SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(last.severity)) {
          last.severity = f.severity
        }
      } else {
        groups.push({ start: f.start, end: f.end, ids: [f.id], severity: f.severity })
      }
    }

    let html = ''
    let pos = 0
    for (const g of groups) {
      html += escapeHtml(text.slice(pos, g.start))
      html += `<mark class="sev-${g.severity}" data-ids="${g.ids.join(',')}">${escapeHtml(text.slice(g.start, g.end))}</mark>`
      pos = g.end
    }
    html += escapeHtml(text.slice(pos))
    return html
  }

  function renderDoc() {
    if (!result) return
    const text = result.doc?.text ?? ''
    const shown = text.slice(0, MAX_RENDER_CHARS)
    dom.docContent.innerHTML = buildHighlighted(shown, result.findings ?? [])
    markIndex = new Map()
    for (const mark of dom.docContent.querySelectorAll('mark[data-ids]')) {
      for (const id of mark.dataset.ids.split(',')) markIndex.set(id, mark)
    }
    if (text.length > MAX_RENDER_CHARS) {
      dom.docTruncated.classList.remove('hidden')
      dom.docTruncated.textContent = `原文过长，仅渲染前 ${formatNumber(MAX_RENDER_CHARS)} 字（完整文本已用于分析）。`
    } else {
      dom.docTruncated.classList.add('hidden')
    }
  }

  // ---------- 发现列表 ----------

  function visibleFindings() {
    const all = result?.findings ?? []
    const q = filters.search.trim().toLowerCase()
    return all.filter((f) => {
      if (filters.severity !== 'all' && f.severity !== filters.severity) return false
      if (filters.hiddenOnly && !f.hidden) return false
      if (!q) return true
      return (
        (f.title ?? '').toLowerCase().includes(q) ||
        (f.quote ?? '').toLowerCase().includes(q) ||
        categoryLabel(f.category).toLowerCase().includes(q) ||
        f.category.toLowerCase().includes(q) ||
        (f.explanation ?? '').toLowerCase().includes(q)
      )
    })
  }

  function findingItemHtml(f) {
    const showImpact = f.impact && f.impact.trim()
    const showAdvice = f.advice && f.advice.trim()
    const clauseLabel = f.clauseHeading ? f.clauseHeading.slice(0, 40) : f.clauseId
    return `
      <li class="finding sev-${f.severity}${f.id === activeFindingId ? ' is-active' : ''}" data-id="${f.id}" tabindex="0">
        <div class="finding-head">
          <span class="badge sev-${f.severity}">${escapeHtml(severityLabel(f.severity))}</span>
          <span class="finding-title">${escapeHtml(f.title)}</span>
          <span class="tag">${escapeHtml(categoryLabel(f.category))}</span>
          ${f.hidden ? '<span class="hidden-badge" title="这个风险不是从字面一眼能看出来的">不明显</span>' : ''}
        </div>
        <div class="finding-quote">${escapeHtml(f.quote)}</div>
        <div class="finding-body">
          ${f.explanation ? `<div class="fb-row"><span class="fb-label">含义</span><span class="fb-text">${escapeHtml(f.explanation)}</span></div>` : ''}
          ${showImpact ? `<div class="fb-row"><span class="fb-label">影响</span><span class="fb-text">${escapeHtml(f.impact)}</span></div>` : ''}
          ${showAdvice ? `<div class="fb-row"><span class="fb-label">建议</span><span class="fb-text">${escapeHtml(f.advice)}</span></div>` : ''}
        </div>
        ${
          (f.wording ?? []).length
            ? `<div class="wording-row" title="这条风险所依据的具体字眼">${(f.wording ?? [])
                .map((w) => `<span class="wording-chip">${escapeHtml(w)}</span>`)
                .join('')}</div>`
            : ''
        }
        <div class="finding-foot">
          <span>出自：${escapeHtml(clauseLabel)}${f.crossClause ? ' · 跨条款引用' : ''}${f.detectedBy === 'rule' ? ' · 规则命中' : ''}</span>
          <button class="locate" type="button" data-locate="${f.id}">在原文中查看 ↓</button>
        </div>
      </li>`
  }

  function renderFindings() {
    if (!result) return
    const items = visibleFindings()
    const total = (result.findings ?? []).length

    dom.findingsCount.textContent = items.length === total ? `${total} 条` : `${items.length} / ${total} 条`

    if (items.length === 0) {
      dom.findingsList.innerHTML = `<li class="empty-state">${
        total === 0 ? '没有发现明显的风险条款。' : '当前筛选条件下没有匹配的条款。'
      }</li>`
      itemIndex = new Map()
      return
    }

    dom.findingsList.innerHTML = items.map(findingItemHtml).join('')
    itemIndex = new Map()
    for (const li of dom.findingsList.querySelectorAll('.finding[data-id]')) {
      itemIndex.set(li.dataset.id, li)
    }
  }

  function renderFilters() {
    const counts = {}
    for (const f of result?.findings ?? []) counts[f.severity] = (counts[f.severity] ?? 0) + 1

    const chips = [
      `<button class="chip is-active" data-sev="all" type="button">全部 ${(result?.findings ?? []).length}</button>`,
    ]
    for (const s of SEVERITY_ORDER) {
      if (!counts[s]) continue
      chips.push(`<button class="chip" data-sev="${s}" type="button">${escapeHtml(severityLabel(s))} ${counts[s]}</button>`)
    }
    dom.severityFilter.innerHTML = chips.join('')
  }

  // ---------- 条款解读 ----------

  const TONE_LABEL = { favorable: '对用户有利', neutral: '中性', unfavorable: '对用户不利', mixed: '喜忧参半' }

  function renderDigest() {
    const notes = result?.clauseNotes ?? []
    dom.digestCount.textContent = String(notes.length)
    dom.digestCount.classList.toggle('hidden', notes.length === 0)

    if (notes.length === 0) {
      dom.digestList.innerHTML = `<li class="empty-state">${
        result?.stats?.mode === 'heuristic'
          ? '本地规则模式无法逐条解读条款含义。配置 API Key 后重新分析即可获得完整解读。'
          : '本次没有生成条款解读。'
      }</li>`
      return
    }

    dom.digestList.innerHTML = notes
      .map(
        (n) => `
      <li class="digest-item tone-${escapeHtml(n.tone)}" data-clause="${escapeHtml(n.clauseId)}" tabindex="0">
        <div class="digest-head">
          <span class="tone-badge">${escapeHtml(TONE_LABEL[n.tone] ?? n.tone)}</span>
          <span class="digest-plain">${escapeHtml(n.plain)}</span>
        </div>
        ${n.meaning ? `<div class="digest-meaning">${escapeHtml(n.meaning)}</div>` : ''}
        ${
          (n.keyPoints ?? []).length
            ? `<ul class="digest-points">${n.keyPoints.map((k) => `<li>${escapeHtml(k)}</li>`).join('')}</ul>`
            : ''
        }
        <div class="digest-ref">
          <span>${escapeHtml(n.clauseHeading || n.clauseId)}</span>
          <button class="locate" type="button" data-locate-clause="${escapeHtml(n.clauseId)}">在原文中查看 ↓</button>
        </div>
      </li>`,
      )
      .join('')
  }

  // ---------- 条款联系 ----------

  function renderInteractions() {
    const list = result?.report?.interactions ?? []
    dom.interactionsCount.textContent = String(list.length)
    dom.interactionsCount.classList.toggle('hidden', list.length === 0)

    if (list.length === 0) {
      dom.interactionsList.innerHTML = `<div class="empty-state">${
        result?.stats?.mode === 'heuristic'
          ? '没有命中已知的条款组合模式。'
          : '未发现明显的跨条款组合效应。'
      }</div>`
      return
    }

    // 条款 id → 可读标题，点击可跳回原文
    const clauseTitle = (id) => {
      const note = (result.clauseNotes ?? []).find((n) => n.clauseId === id)
      const clause = (result.clauses ?? []).find((c) => c.id === id)
      return note?.plain || clause?.heading || id
    }

    dom.interactionsList.innerHTML = list
      .map(
        (x) => `
      <div class="interaction sev-${escapeHtml(x.severity)}">
        <div class="interaction-head">
          <span class="badge sev-${escapeHtml(x.severity)}">${escapeHtml(severityLabel(x.severity))}</span>
          <span class="interaction-title">${escapeHtml(x.title)}</span>
        </div>
        <div class="interaction-chain">
          ${x.clauseIds
            .map(
              (id, i) =>
                `${i > 0 ? '<span class="chain-plus">+</span>' : ''}<button class="chain-node" type="button" data-locate-clause="${escapeHtml(
                  id,
                )}" title="${escapeHtml(clauseTitle(id))}">${escapeHtml(clauseTitle(id).slice(0, 22))}</button>`,
            )
            .join('')}
        </div>
        ${x.explanation ? `<div class="interaction-body">${escapeHtml(x.explanation)}</div>` : ''}
        ${x.scenario ? `<div class="interaction-scenario">${escapeHtml(x.scenario)}</div>` : ''}
      </div>`,
      )
      .join('')
  }

  // ---------- 各区块 ----------

  function renderScore() {
    const report = result.report ?? {}
    const score = Number(report.riskScore ?? 0)
    const color = scoreColor(score)

    dom.scoreValue.textContent = String(score)
    dom.scoreVerdict.textContent = report.verdict ?? ''
    const ring = dom.ringFg
    ring.style.stroke = color
    // 触发过渡：先归零再设置目标值
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE)
    requestAnimationFrame(() => {
      ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, score)) / 100))
    })

    const counts = {}
    for (const f of result.findings ?? []) counts[f.severity] = (counts[f.severity] ?? 0) + 1
    dom.severityCounts.innerHTML = SEVERITY_ORDER.filter((s) => counts[s])
      .map((s) => `<span class="sev-count sev-${s}">${escapeHtml(severityLabel(s))} ${counts[s]}</span>`)
      .join('')
  }

  function renderReport() {
    const report = result.report ?? {}

    dom.reportSummary.textContent = report.summary || '（模型未给出摘要）'
    dom.reportReadability.textContent = report.readability ? `可读性：${report.readability}` : ''
    dom.reportReadability.classList.toggle('hidden', !report.readability)

    // 最需关注
    const concerns = report.topConcerns ?? []
    if (concerns.length === 0) {
      dom.cardTop.classList.add('hidden')
    } else {
      dom.cardTop.classList.remove('hidden')
      dom.topConcerns.innerHTML = concerns
        .map(
          (c) => `
          <li data-clause="${escapeHtml(c.clauseId ?? '')}">
            <div class="tc-title">
              <span class="badge sev-${escapeHtml(c.severity)}">${escapeHtml(severityLabel(c.severity))}</span>
              ${escapeHtml(c.title)}
            </div>
            <div class="tc-why">${escapeHtml(c.why)}</div>
          </li>`,
        )
        .join('')
    }

    // 类别分布
    const cats = report.categorySummary ?? []
    if (cats.length === 0) {
      dom.cardCategories.classList.add('hidden')
    } else {
      dom.cardCategories.classList.remove('hidden')
      dom.categorySummary.innerHTML = cats
        .map(
          (c) => `
          <li>
            <div>
              <div class="cat-name">${escapeHtml(categoryLabel(c.category))}</div>
              ${c.note ? `<div class="cat-note">${escapeHtml(c.note)}</div>` : ''}
            </div>
            <span class="cat-count">${c.count || ''}</span>
          </li>`,
        )
        .join('')
    }

    // 建议
    const actions = report.actions ?? []
    dom.cardActions.classList.toggle('hidden', actions.length === 0)
    dom.reportActions.innerHTML = actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')

    // 相对合理之处
    const positives = report.positives ?? []
    dom.cardPositives.classList.toggle('hidden', positives.length === 0)
    dom.reportPositives.innerHTML = positives.map((a) => `<li>${escapeHtml(a)}</li>`).join('')

    // 统计
    const st = result.stats ?? {}
    const usage = st.usage ?? {}
    const rows = [
      ['分析模式', st.mode === 'heuristic' ? '本地规则（未调用模型）' : '模型分析'],
      ['模型', st.model || '—'],
      ['协议字数', formatNumber(result.doc?.chars)],
      ['条款数', formatNumber(result.doc?.clauseCount)],
      ['切分方式', st.mode === 'heuristic' ? '结构 / 段落' : result.doc?.segmentStrategy === 'structure' ? '编号结构' : '段落聚合'],
      ['风险条目', formatNumber((result.findings ?? []).length)],
      ['引文核验', `${st.verify?.kept ?? 0} 条通过${st.verify?.dropped ? `，弃用 ${st.verify.dropped}` : ''}`],
      ['规则预扫描', `${formatNumber(st.prescanHits)} 处命中`],
      ['耗时', formatDuration(st.ms)],
      ['Token 用量', usage.total_tokens ? formatNumber(usage.total_tokens) : '—'],
      ['分析时间', formatDate(result.createdAt)],
    ]
    dom.resultStats.innerHTML = rows
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
      .join('')
  }

  function renderWarnings() {
    const warnings = result.warnings ?? []
    const extractionWarnings = result.extraction?.warnings ?? []
    const all = [...new Set([...extractionWarnings, ...warnings])]
    if (all.length === 0) {
      dom.resultWarnings.classList.add('hidden')
      return
    }
    dom.resultWarnings.classList.remove('hidden')
    dom.resultWarnings.innerHTML = `<strong>请注意</strong><ul>${all.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
  }

  function renderHeader() {
    const mode = result.stats?.mode
    dom.resultTitle.textContent = result.doc?.title || '分析报告'
    const bits = [
      `${formatNumber(result.doc?.chars)} 字`,
      `${formatNumber(result.doc?.clauseCount)} 个条款`,
      `${(result.findings ?? []).length} 条风险`,
      formatDate(result.createdAt),
    ]
    if (mode === 'heuristic') bits.push('本地规则模式')
    dom.resultMeta.textContent = bits.join(' · ')
  }

  // ---------- 选中联动 ----------

  function select(findingId, { scrollDoc = true, scrollList = false } = {}) {
    if (!result) return
    activeFindingId = findingId

    for (const el of dom.findingsList.querySelectorAll('.finding')) {
      el.classList.toggle('is-active', el.dataset.id === findingId)
    }
    for (const el of dom.docContent.querySelectorAll('mark')) {
      el.classList.remove('is-active')
    }
    const mark = markIndex.get(findingId)
    if (mark) {
      mark.classList.add('is-active')
      if (scrollDoc) mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    if (scrollList) {
      const li = itemIndex.get(findingId)
      li?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    const finding = (result.findings ?? []).find((f) => f.id === findingId)
    if (finding) handlers.onLocate?.(finding)
  }

  /** 找到某条款的第一条发现（供「最需关注」跳转） */
  function selectByClause(clauseId) {
    const f = (result.findings ?? []).find((x) => x.clauseId === clauseId)
    if (f) {
      // 若被筛选隐藏，先重置筛选，保证跳转可见
      if (!visibleFindings().some((x) => x.id === f.id)) {
        filters.severity = 'all'
        filters.search = ''
        dom.findingsSearch.value = ''
        renderFilters()
        renderFindings()
      }
      select(f.id, { scrollDoc: true, scrollList: true })
    }
  }

  // ---------- 事件绑定（只绑一次） ----------

  // ---------- 标签页 ----------

  function switchTab(name) {
    for (const t of dom.resultTabs.querySelectorAll('.tab[data-rtab]')) {
      t.classList.toggle('is-active', t.dataset.rtab === name)
    }
    for (const p of dom.docCol.querySelectorAll('.rtab-panel[data-rpanel]')) {
      p.classList.toggle('is-active', p.dataset.rpanel === name)
    }
  }

  dom.resultTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab[data-rtab]')
    if (tab) switchTab(tab.dataset.rtab)
  })

  dom.filterHidden.addEventListener('change', () => {
    filters.hiddenOnly = dom.filterHidden.checked
    renderFindings()
  })

  /**
   * 跳到原文并高亮某条款。
   *
   * 原文面板现在是**常驻显示**的（不藏在标签页里），所以这里不需要切换标签，
   * 只要把它滚进视野并高亮即可 —— 结论和原文能同时看到，核对才不用来回切。
   */
  function locateClause(clauseId) {
    if (!clauseId) return

    // 优先用该条款上的风险条目（会带上精确的原文区间）
    const finding = (result?.findings ?? []).find((f) => f.clauseId === clauseId)
    if (finding) {
      select(finding.id, { scrollDoc: true })
      return
    }

    // 该条款没有风险条目：退而找原文里属于这条的任意高亮
    let best = null
    for (const m of dom.docContent.querySelectorAll('mark[data-ids]')) {
      const firstId = m.dataset.ids.split(',')[0]
      const f = (result?.findings ?? []).find((x) => x.id === firstId)
      if (f && f.clauseId === clauseId) {
        best = m
        break
      }
    }

    if (best) {
      best.scrollIntoView({ behavior: 'smooth', block: 'center' })
      best.classList.add('is-active')
      setTimeout(() => best?.classList.remove('is-active'), 2000)
    } else {
      // 连高亮都没有（例如解读覆盖了没有风险的条款）→ 至少在原文区域给出位置感
      dom.docContent.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    handlers.onLocateClause?.(clauseId)
  }

  dom.digestList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-locate-clause]')
    if (btn) {
      e.stopPropagation()
      locateClause(btn.dataset.locateClause)
    }
  })

  dom.interactionsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-locate-clause]')
    if (btn) locateClause(btn.dataset.locateClause)
  })

  dom.findingsList.addEventListener('click', (e) => {
    const locateBtn = e.target.closest('[data-locate]')
    if (locateBtn) {
      e.stopPropagation()
      select(locateBtn.dataset.locate, { scrollDoc: true })
      return
    }
    const li = e.target.closest('.finding[data-id]')
    if (li) select(li.dataset.id, { scrollDoc: true })
  })

  dom.findingsList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const li = e.target.closest('.finding[data-id]')
    if (li) {
      e.preventDefault()
      select(li.dataset.id, { scrollDoc: true })
    }
  })

  dom.docContent.addEventListener('click', (e) => {
    const mark = e.target.closest('mark[data-ids]')
    if (!mark) return
    const firstId = mark.dataset.ids.split(',')[0]
    select(firstId, { scrollDoc: false, scrollList: true })
  })

  dom.severityFilter.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-sev]')
    if (!chip) return
    filters.severity = chip.dataset.sev
    for (const c of dom.severityFilter.querySelectorAll('.chip')) c.classList.toggle('is-active', c === chip)
    renderFindings()
  })

  dom.findingsSearch.addEventListener(
    'input',
    debounce(() => {
      filters.search = dom.findingsSearch.value
      renderFindings()
    }, 160),
  )

  dom.topConcerns.addEventListener('click', (e) => {
    const li = e.target.closest('[data-clause]')
    if (li?.dataset.clause) selectByClause(li.dataset.clause)
  })

  dom.toggleHighlight.addEventListener('change', () => {
    // 用类名切换，保留 <mark> 结构与选中联动，只改视觉效果
    dom.docContent.classList.toggle('no-highlight', !dom.toggleHighlight.checked)
  })

  let fontScale = 1
  const applyFont = () => {
    dom.docContent.style.fontSize = `${14 * fontScale}px`
  }
  dom.btnFontUp.addEventListener('click', () => {
    fontScale = Math.min(1.6, fontScale + 0.1)
    applyFont()
  })
  dom.btnFontDown.addEventListener('click', () => {
    fontScale = Math.max(0.75, fontScale - 0.1)
    applyFont()
  })

  // ---------- 对外接口 ----------

  return {
    show(nextResult) {
      result = nextResult
      activeFindingId = null
      filters.severity = 'all'
      filters.search = ''
      filters.hiddenOnly = false
      dom.findingsSearch.value = ''
      dom.filterHidden.checked = false
      dom.toggleHighlight.checked = true
      dom.docContent.classList.remove('no-highlight')
      dom.docContent.scrollTop = 0
      fontScale = 1
      applyFont()

      renderHeader()
      renderWarnings()
      renderScore()
      renderReport()
      renderFilters()
      renderFindings()
      renderDigest()
      renderInteractions()
      renderDoc()
      switchTab('findings')

      // 默认选中第一条，让用户立刻看到「结论 ↔ 原文」的联动
      const first = (result.findings ?? [])[0]
      if (first) select(first.id, { scrollDoc: false })
    },
    get result() {
      return result
    },
    selectByClause,
    locateClause,
    switchTab,
    /** 问答里点证据时调用：跳到原文并聚焦到该条款 */
    focusClause: locateClause,
  }
}

export { SEVERITY_ORDER }
