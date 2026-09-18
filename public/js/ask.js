/**
 * 问答面板（前端）。
 *
 * 核心是把「知识库」这件事讲清楚：用户可以勾选多份协议一起作为回答依据，
 * 界面上要能随时看到当前知识库包含什么，以及答案里每条依据来自哪一份。
 */
import * as api from './api.js'
import { escapeHtml, formatNumber } from './util.js'

const CONFIDENCE_LABEL = { high: '依据明确', medium: '依据一般', low: '依据薄弱' }

/** 由分析结果里的风险类别反推出几个值得问的问题 */
function suggestQuestions(result) {
  const cats = new Set((result?.findings ?? []).map((f) => f.category))
  const pool = [
    ['auto_renewal', '会自动扣费吗？怎么取消？'],
    ['refund', '付了钱能退吗？'],
    ['data_sharing', '我的数据会被共享给谁？'],
    ['privacy_tracking', '平台会追踪我的行为吗？'],
    ['content_license', '我发的内容会被平台拿去用吗？'],
    ['account_termination', '账号被封了会怎样？'],
    ['arbitration', '发生争议要去哪里解决？'],
    ['unilateral_change', '平台能随便改协议吗？'],
    ['data_retention', '注销后我的数据还会留着吗？'],
    ['liability_disclaimer', '服务出问题平台负责吗？'],
  ]
  return pool.filter(([c]) => cats.has(c)).map(([, q]) => q).slice(0, 3)
}

/**
 * @param {object} p
 * @param {Record<string, HTMLElement>} p.dom
 * @param {(clauseId:string, docId?:string)=>void} p.onLocate 点击依据时跳回原文
 * @param {(msg:string, isError?:boolean)=>void} p.toast
 */
export function createAskPanel({ dom, onLocate, toast, hasKey, openSettings }) {
  /** @type {Array<{id:string,title:string,result:object,clauses:number,current?:boolean}>} */
  let available = []
  let selected = new Set()
  const asked = []
  let busy = false

  // ---------- 知识库 ----------

  function refreshAvailable(currentResult, historyEntries) {
    available = []
    if (currentResult) {
      available.push({
        id: currentResult.id,
        title: currentResult.doc?.title || '当前协议',
        result: currentResult,
        clauses: currentResult.clauses?.length ?? 0,
        current: true,
      })
    }
    for (const e of historyEntries ?? []) {
      if (!e?.result) continue
      if (available.some((a) => a.id === e.id)) continue
      available.push({
        id: e.id,
        title: e.title || e.result?.doc?.title || '未命名协议',
        result: e.result,
        clauses: e.result?.clauses?.length ?? 0,
      })
    }

    // 默认只选当前协议；若没有当前协议（例如从历史打开），至少选第一份
    const stillValid = new Set(available.map((a) => a.id))
    selected = new Set([...selected].filter((id) => stillValid.has(id)))
    if (selected.size === 0 && available.length > 0) {
      selected = new Set([available[0].id])
    }

    renderCorpusList()
    renderCorpusSummary()
  }

  function renderCorpusList() {
    if (available.length === 0) {
      dom.askCorpusList.innerHTML = '<li class="empty-state">还没有可用的协议。</li>'
      return
    }
    dom.askCorpusList.innerHTML = available
      .map(
        (a) => `
      <li>
        <input type="checkbox" data-doc="${escapeHtml(a.id)}" ${selected.has(a.id) ? 'checked' : ''} />
        <span>${escapeHtml(a.title)}${a.current ? ' <span class="tag">当前</span>' : ''}</span>
        <span class="corpus-meta">${formatNumber(a.clauses)} 个条款</span>
      </li>`,
      )
      .join('')
  }

  function renderCorpusSummary() {
    const picked = available.filter((a) => selected.has(a.id))
    const clauses = picked.reduce((s, a) => s + a.clauses, 0)
    dom.askCorpusSummary.textContent =
      picked.length === 0
        ? '未选择'
        : picked.length === 1
          ? `${picked[0].title}`
          : `${picked.length} 份协议（共 ${formatNumber(clauses)} 条款）`
  }

  function selectedDocuments() {
    return available.filter((a) => selected.has(a.id)).map((a) => a.result)
  }

  /** 没有 API Key 时给出明确指引，而不是让它变成一个含糊的报错 */
  function renderNoKey() {
    setStatus('')
    dom.askAnswer.innerHTML = `
      <div class="answer-card is-unverified">
        <div class="answer-meta"><span class="badge sev-high">还没有配置 API Key</span></div>
        <div class="answer-text">
          协议问答需要调用模型，但当前地址下没有找到你的 API Key。<br><br>
          <strong>API Key 是按访问地址分别保存的。</strong>
          如果你之前在别的地址填过（例如 WSL 的 <code>172.x.x.x:8787</code>），
          换成 <code>127.0.0.1:8787</code> 之后就是另一份存储，需要重新填一次。
          <br><br>填一次之后就会一直记住。
        </div>
        <div class="ur-actions">
          <button class="btn btn-primary" type="button" data-ask-action="settings">去填写 API Key</button>
        </div>
      </div>`
  }

  dom.askAnswer.addEventListener('click', (e) => {
    if (e.target.closest('[data-ask-action="settings"]')) openSettings?.()
  })

  // ---------- 提问 ----------

  function setStatus(text, kind = '') {
    dom.askStatus.textContent = text
    dom.askStatus.className = kind ? `hint ask-status-${kind}` : 'hint'
  }

  /** 把检索过程翻译成一句人话，让用户知道答案是怎么找出来的 */
  function describeRetrieval(res) {
    const secs = ((res.ms ?? 0) / 1000).toFixed(1)
    const r = res.retrieval ?? {}
    // 注意：wholeDocument 既可能来自「全文送检」，也可能来自「超限时送能装下的部分」
    if (r.mode === 'full-context') {
      return `已把协议全文（约 ${Math.round((r.chars ?? 0) / 1000)} 千字）交给模型判断，用时 ${secs} 秒。`
    }
    if (r.mode === 'full-context-partial') {
      return `没定位到相关条款，已把前 ${r.clauses ?? 0} 个条款（约 ${Math.round(
        (r.chars ?? 0) / 1000,
      )} 千字）交给模型判断，用时 ${secs} 秒。`
    }
    if (r.relaxed) {
      return `已放宽匹配条件，从 ${r.scored ?? 0} 个候选条款中筛选后交给模型，用时 ${secs} 秒。`
    }
    const n = (res.evidence?.length ?? 0) || (r.scored ?? 0)
    if (n > 0) return `已定位 ${n} 个相关条款，用时 ${secs} 秒。`

    const d = res.diagnostics
    if (!d) {
      // 旧版服务不会返回这个字段 —— 与其显示「? 个条款」让人一头雾水，
      // 不如直接说清楚问题在哪
      return `没收到完整的回答信息，用时 ${secs} 秒。收到的字段：${Object.keys(res).join(', ') || '(空)'}`
    }
    if (d.sentClauses === 0) {
      return `没有把任何内容交给模型（语料 ${d.clauses} 个条款 / 约 ${Math.round((d.corpusChars ?? 0) / 1000)} 千字，上限 ${Math.round((d.budget ?? 0) / 1000)} 千字），因此无法回答。请看下方诊断。`
    }
    return `已把 ${d.sentClauses} 个条款（约 ${Math.round((d.sentChars ?? 0) / 1000)} 千字）交给模型判断，用时 ${secs} 秒。`
  }

  function renderAnswer(res) {
    const notFound = res.answerable === false
    const unverified = res.verification?.forcedNotFound
    const cls = unverified ? 'is-unverified' : notFound ? 'is-notfound' : 'is-found'

    const parts = [`<div class="answer-card ${cls}">`]

    parts.push('<div class="answer-meta">')
    parts.push(
      `<span class="confidence-badge confidence-${escapeHtml(res.confidence)}">${escapeHtml(
        CONFIDENCE_LABEL[res.confidence] ?? res.confidence,
      )}</span>`,
    )
    if (unverified) parts.push('<span class="badge sev-high">未能核验</span>')
    else if (notFound) parts.push('<span class="badge sev-medium">协议中未找到</span>')
    if (res.web?.used) parts.push('<span class="tag">含联网信息</span>')
    // 只在确实有文档信息时才显示，避免出现让人困惑的"0 份协议"
    const docCount = res.documents?.length ?? 0
    if (docCount > 0) parts.push(`<span class="tag">${docCount} 份协议</span>`)
    if (res.wholeDocument) parts.push('<span class="tag">整篇送检</span>')
    if (res.evidence?.length) parts.push(`<span class="tag">${res.evidence.length} 条依据</span>`)
    parts.push('</div>')

    parts.push(`<div class="answer-text">${escapeHtml(res.answer)}</div>`)

    if (res.evidence?.length) {
      parts.push('<div class="answer-section-title">依据（点击可跳回原文）</div>')
      parts.push('<ul class="evidence-list">')
      for (const e of res.evidence) {
        parts.push(`
          <li class="evidence-item" data-clause="${escapeHtml(e.clauseId)}" data-doc="${escapeHtml(e.docId ?? '')}">
            <div class="evidence-quote">${escapeHtml(e.quote)}</div>
            <div class="evidence-foot">
              <span>${escapeHtml(e.docTitle ?? '')}　${escapeHtml(e.clauseHeading || e.clauseId)}</span>
              ${e.note ? `<span>${escapeHtml(e.note)}</span>` : ''}
            </div>
          </li>`)
      }
      parts.push('</ul>')
    }

    if (res.explainers?.length) {
      parts.push('<div class="answer-section-title">概念解释（通用说明，非协议内容）</div>')
      parts.push(`<ul class="caveat-list explainer-list">${res.explainers.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`)
    }

    if (res.caveats?.length) {
      parts.push('<div class="answer-section-title">需要注意</div>')
      parts.push(`<ul class="caveat-list">${res.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`)
    }

    if (res.web?.results?.length) {
      parts.push('<div class="answer-section-title">联网搜索结果（外部信息，非协议内容）</div>')
      parts.push(
        `<ul class="web-list">${res.web.results
          .map(
            (r) =>
              `<li><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                r.title || r.url,
              )}</a><br>${escapeHtml((r.snippet ?? '').slice(0, 160))}</li>`,
          )
          .join('')}</ul>`,
      )
    }

    if (res.warnings?.length) {
      parts.push('<div class="answer-section-title">过程提示</div>')
      parts.push(`<ul class="caveat-list">${res.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`)
    }

    // 诊断信息：回答异常时用户能自助定位，也方便反馈问题时截图
    const d = res.diagnostics
    if (!d) {
      parts.push('<div class="answer-section-title">服务版本</div>')
      parts.push(
        `<ul class="caveat-list"><li>服务端没有返回诊断信息。收到的字段：<code>${escapeHtml(
          Object.keys(res).join(', ') || '(空)',
        )}</code></li></ul>`,
      )
    }
    if (d) {
      parts.push(`<details class="diag-box"><summary>诊断信息</summary>
        <dl class="diag-list">
          <dt>知识库</dt><dd>${d.documents} 份协议 / ${d.clauses} 个条款 / 约 ${formatNumber(Math.round((d.corpusChars ?? 0) / 1000))} 千字</dd>
          <dt>送检内容</dt><dd>${d.sentClauses} 个条款 / 约 ${formatNumber(Math.round((d.sentChars ?? 0) / 1000))} 千字</dd>
          <dt>上下文策略</dt><dd>${escapeHtml(d.contextMode)}（上限 ${formatNumber(Math.round((d.budget ?? 0) / 1000))} 千字）</dd>
          ${d.truncatedDocs ? `<dt>截断记录</dt><dd>${d.truncatedDocs} 份协议的历史记录被截断，部分条款不在依据内</dd>` : ''}
          <dt>依据核验</dt><dd>收到 ${res.verification?.input ?? 0} 条，通过 ${res.verification?.kept ?? 0} 条，丢弃 ${res.verification?.dropped ?? 0} 条</dd>
        </dl>
      </details>`)
    }

    parts.push('</div>')
    dom.askAnswer.innerHTML = parts.join('')

    // 追问建议
    if (res.relatedQuestions?.length) {
      dom.askSuggest.innerHTML = res.relatedQuestions
        .map((q) => `<button class="chip" type="button" data-ask="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
        .join('')
    }
  }

  async function submit() {
    if (busy) return
    const question = dom.askQuestion.value.trim()
    if (!question) {
      setStatus('请先输入问题。', 'bad')
      dom.askQuestion.focus()
      return
    }

    // 先查有没有 Key。**没有 Key 是提问失败最常见的原因**，
    // 而且很容易被误解成"服务坏了" —— 因为 API Key 是按来源站存的，
    // 换了访问地址（127.0.0.1 ↔ WSL 的 IP）就等于换了一份存储，Key 不会跟着走。
    if (!hasKey()) {
      renderNoKey()
      return
    }

    const docs = selectedDocuments()
    if (docs.length === 0) {
      setStatus('请先在「知识库」里勾选至少一份协议。', 'bad')
      return
    }

    busy = true
    dom.askSubmit.disabled = true
    dom.askSubmit.textContent = '思考中…'
    setStatus(dom.askWeb.checked ? '正在检索协议并联网搜索…' : '正在检索协议并作答…')

    try {
      const res = await api.ask({
        question,
        documents: docs,
        useWeb: dom.askWeb.checked,
      })
      renderAnswer(res)
      setStatus(describeRetrieval(res))
      asked.unshift(question)
      renderAsked()
    } catch (err) {
      setStatus('')
      dom.askAnswer.innerHTML = `<div class="answer-card is-unverified">
        <div class="answer-meta"><span class="badge sev-high">提问失败</span></div>
        <div class="answer-text">${escapeHtml(err.message)}</div>
      </div>`
      if (/API Key/.test(err.message)) toast('需要先配置 API Key', true)
    } finally {
      busy = false
      dom.askSubmit.disabled = false
      dom.askSubmit.textContent = '提问'
    }
  }

  function renderAsked() {
    if (asked.length === 0) {
      dom.askHistory.innerHTML = ''
      return
    }
    dom.askHistory.innerHTML = asked
      .slice(0, 8)
      .map((q) => `<li data-ask="${escapeHtml(q)}">↺ ${escapeHtml(q)}</li>`)
      .join('')
  }

  // ---------- 事件 ----------

  dom.askSubmit.addEventListener('click', submit)

  dom.askQuestion.addEventListener('keydown', (e) => {
    // Enter 提交，Shift+Enter 换行 —— 和主流聊天框一致
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  })

  dom.btnAskCorpus.addEventListener('click', () => {
    dom.askCorpusPanel.classList.toggle('hidden')
  })

  dom.askCorpusList.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-doc]')
    if (!cb) return
    if (cb.checked) selected.add(cb.dataset.doc)
    else selected.delete(cb.dataset.doc)
    renderCorpusSummary()
  })

  dom.askSuggest.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ask]')
    if (!chip) return
    dom.askQuestion.value = chip.dataset.ask
    dom.askQuestion.focus()
  })

  dom.askHistory.addEventListener('click', (e) => {
    const li = e.target.closest('[data-ask]')
    if (!li) return
    dom.askQuestion.value = li.dataset.ask
    dom.askQuestion.focus()
  })

  dom.askAnswer.addEventListener('click', (e) => {
    const item = e.target.closest('.evidence-item')
    if (item) onLocate?.(item.dataset.clause, item.dataset.doc)
  })

  return {
    /** 切换当前分析结果时刷新知识库与建议问题 */
    setCurrent(result, historyEntries) {
      // 没有 Key 就直接显示提示，不要等用户点了才说
      if (!hasKey()) renderNoKey()
      refreshAvailable(result, historyEntries)
      dom.askSuggest.innerHTML = suggestQuestions(result)
        .map((q) => `<button class="chip" type="button" data-ask="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
        .join('')
    },
    /** 每次打开结果页时重置答案区，避免把上一份协议的回答留在这里 */
    resetAnswer() {
      dom.askAnswer.innerHTML = ''
      dom.askHistory.innerHTML = ''
      asked.length = 0
      setStatus('')
      if (!hasKey()) renderNoKey()
    },
    focusQuestion() {
      dom.askQuestion.focus()
    },
  }
}
