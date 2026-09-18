/**
 * 应用主逻辑：视图切换、输入处理、进度展示、结果落地、历史记录。
 */
import * as api from './api.js'
import { createResultView } from './render.js'
import * as store from './store.js'
import { createSettingsPanel, loadCredentials } from './settings.js'
import { createAskPanel } from './ask.js'
import { createLegalPanel } from './legal.js'
import { buildBookmarklet } from './bookmarklet.js'
import { toMarkdown, downloadText, safeFilename } from './export.js'
import { escapeHtml, formatBytes, formatDate, formatNumber, scoreColor } from './util.js'

const $ = (id) => document.getElementById(id)

/** 分析阶段定义（与后端 onEvent 的 stage 对应） */
const STAGES = [
  { id: 'normalize', label: '清理与归一化文本' },
  { id: 'segment', label: '识别协议结构与条款' },
  { id: 'prescan', label: '本地规则预扫描' },
  { id: 'map', label: '逐条审查风险条款' },
  { id: 'verify', label: '核验引文出处' },
  { id: 'reduce', label: '生成整体评估' },
]

/** 前端期望的接口契约版本，必须与服务端 server.js 的 API_VERSION 一致 */
const EXPECTED_API_VERSION = 2

const state = {
  config: null,
  taxonomy: { categories: [], severityLabels: {} },
  modelSuggestions: [],
  credentials: { apiKey: '', baseUrl: '', model: '', modelSummary: '', remember: true },
  mode: 'unknown',
  capabilities: null,
  settings: null,
  ask: null,
  legal: null,
  abortController: null,
  analyzing: false,
  result: null,
  extraction: null,
  baselineHistoryId: null,
  view: null,
  ingestSeq: 0,
  ingestTimer: null,
}

// ============================================================
// 视图切换
// ============================================================

function showView(name) {
  for (const v of ['input', 'progress', 'result']) {
    $(`view-${v}`).classList.toggle('hidden', v !== name)
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ============================================================
// Toast
// ============================================================

let toastTimer
function toast(message, isError = false) {
  const el = $('toast')
  el.textContent = message
  el.classList.toggle('is-error', Boolean(isError))
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 3200)
}

// ============================================================
// 状态指示
// ============================================================

/**
 * 把凭据同步到 API 层与界面。
 * @param {{apiKey:string, baseUrl:string, model:string, modelSummary:string, remember:boolean}} creds
 */
function applyCredentials(creds) {
  state.credentials = creds
  api.setCredentials(creds)
  renderStatus()
}

/** 当前是否有可用的密钥（浏览器里填的，或服务端 .env 配的） */
function hasAnyKey() {
  return Boolean(state.credentials?.apiKey) || Boolean(state.config?.hasApiKey)
}

function renderStatus() {
  const el = $('status')
  const text = $('status-text')
  const cfg = state.config
  const c = state.credentials ?? {}
  el.classList.remove('is-ok', 'is-warn', 'is-bad')

  if (!cfg) {
    if (state.configFailed) {
      el.classList.add('is-bad')
      text.textContent = '服务不可用'
    } else {
      text.textContent = '连接中…'
    }
    return
  }

  const banner = $('key-banner')

  if (cfg.mock) {
    el.classList.add('is-warn')
    text.textContent = '离线 Mock 模式'
    el.title = '服务端以 DSH_AGREEMENT_MOCK=1 启动，只返回本地规则结果，不会调用模型。'
    banner.classList.add('hidden')
    return
  }

  if (c.apiKey) {
    el.classList.add('is-ok')
    text.textContent = '真实模型 · 浏览器密钥'
    el.title = [
      `使用你在本页填写的 API Key（…${c.apiKey.slice(-4)}）`,
      `接口：${c.baseUrl || cfg.baseUrl}`,
      `逐条模型：${c.model || cfg.model}`,
      `汇总模型：${c.modelSummary || c.model || cfg.modelSummary}`,
      '点击可修改。',
    ].join('\n')
    banner.classList.add('hidden')
    return
  }

  if (cfg.hasApiKey) {
    el.classList.add('is-ok')
    text.textContent = `真实模型 · 服务端密钥`
    el.title = `使用服务端 .env 中配置的密钥。\n逐条模型：${cfg.model}\n点击可改用你自己的密钥。`
    banner.classList.add('hidden')
    return
  }

  el.classList.add('is-warn')
  text.textContent = '未配置 API Key · 本地规则模式'
  el.title = '点这里填入 DeepSeek API Key，即可使用真实模型分析。\n（本地规则模式只用关键词匹配，准确率明显较低）'
  banner.classList.remove('hidden')
}

// ============================================================
// 输入处理
// ============================================================

function updateTextCount() {
  const n = $('input-text').value.length
  $('text-count').textContent = `${formatNumber(n)} 字`
}

function setExtractionMeta(meta, text, title) {
  const box = $('extract-meta')
  if (!meta) {
    box.classList.add('hidden')
    box.innerHTML = ''
    return
  }
  const warnings = meta.warnings ?? []
  box.classList.remove('hidden')
  box.innerHTML = `
    <div class="em-title">
      <span class="pill">${escapeHtml(meta.format ?? 'text')}</span>
      <span>${escapeHtml(meta.extractor ?? '')}</span>
      <span class="hint">${formatNumber(text.length)} 字${meta.pageCount ? ` · ${meta.pageCount} 页` : ''}${
        meta.bytes ? ` · ${formatBytes(meta.bytes)}` : ''
      }${title ? ` · ${escapeHtml(title)}` : ''}</span>
    </div>
    ${
      warnings.length
        ? `<ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
        : '<div class="hint">提取完成，文本已填入上方编辑框。确认无误后点击「开始分析」。</div>'
    }`
}

/** 处理上传的文件（支持多选，按顺序拼接） */
async function handleFiles(files) {
  const list = [...files]
  if (list.length === 0) return

  const listEl = $('file-list')
  listEl.innerHTML = ''
  const texts = []
  let lastMeta = null
  let title = ''

  for (const file of list) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="file-name">${escapeHtml(file.name)}</span><span class="file-info">解析中…</span>`
    listEl.appendChild(li)
    const info = li.querySelector('.file-info')

    try {
      const res = await api.extractFile(file)
      if (res.text?.trim()) {
        texts.push(res.text)
        info.textContent = `${formatNumber(res.text.length)} 字 · ${res.meta?.format ?? ''}`
        lastMeta = { ...res.meta, bytes: file.size, filename: file.name }
        if (!title && res.title) title = res.title
      } else {
        info.textContent = '未提取到文本'
        info.style.color = '#dc2626'
        lastMeta = { ...res.meta, bytes: file.size, filename: file.name }
      }
      if (!title) title = file.name.replace(/\.[^.]+$/, '')
    } catch (err) {
      info.textContent = err.message
      info.style.color = '#dc2626'
    }
  }

  if (texts.length) {
    $('input-text').value = texts.join('\n\n')
    if (title) $('input-title').value = title
    updateTextCount()
  }
  setExtractionMeta(lastMeta, texts.join('\n\n'), title)
  if (texts.length > 1) toast(`已合并 ${texts.length} 个文件的文本`)
  else if (texts.length === 1) toast('提取完成，请确认文本后开始分析')
  else toast('没有从文件中提取到文本', true)
}

// ============================================================
// 进度
// ============================================================

function resetStages() {
  $('stage-list').innerHTML = STAGES.map(
    (s) => `<li data-stage="${s.id}"><span class="stage-icon">○</span><span class="stage-text">${escapeHtml(s.label)}</span></li>`,
  ).join('')
  $('progress-bar').style.width = '0%'
  $('progress-title').textContent = '正在分析…'
}

function updateStage(event) {
  const { stage, message, done, total } = event
  const idx = STAGES.findIndex((s) => s.id === stage)
  if (idx === -1) return

  for (const li of $('stage-list').children) {
    const sid = li.dataset.stage
    const sIdx = STAGES.findIndex((s) => s.id === sid)
    if (sIdx < idx) {
      li.className = 'is-done'
      li.querySelector('.stage-icon').textContent = '✓'
    } else if (sIdx === idx) {
      li.className = 'is-active'
      li.querySelector('.stage-icon').textContent = '●'
      if (message) li.querySelector('.stage-text').textContent = message
    }
  }

  // 进度条：阶段占 80%，最后 20% 留给结果组装
  let pct = (idx / STAGES.length) * 80
  if (stage === 'map' && Number.isFinite(done) && Number.isFinite(total) && total > 0) {
    pct = ((idx + done / total) / STAGES.length) * 80
    $('progress-title').textContent = `正在逐条审查（${done}/${total} 批）…`
  }
  $('progress-bar').style.width = `${Math.min(96, pct)}%`
}

function finishStages() {
  for (const li of $('stage-list').children) {
    li.className = 'is-done'
    li.querySelector('.stage-icon').textContent = '✓'
  }
  $('progress-bar').style.width = '100%'
}

// ============================================================
// 分析
// ============================================================

/**
 * 抓取网址并把结果（成功或失败）都以**常驻面板**的形式呈现。
 *
 * 之前的实现只用 toast 提示失败，几秒后消失，用户会以为"点了没反应"。
 * 现在把诊断信息、原因和替代方案固定显示出来。
 */
// ============================================================
// 抓取书签：用用户自己的浏览器取内容
// ============================================================

function renderIngestPanel(item) {
  const box = $('ingest-panel')
  box.classList.remove('hidden')
  box.className = 'url-result is-ok'
  box.innerHTML = `
    <div class="ur-head">📥 收到来自浏览器书签的内容　<span class="pill">${formatNumber(item.chars)} 字</span></div>
    <p class="ur-why">${escapeHtml(item.title || '（无标题）')}<br><span class="hint">${escapeHtml(item.url || '')}</span></p>
    <div class="ur-actions">
      <button class="btn btn-primary" data-ingest="load" type="button">载入并查看</button>
      <button class="btn btn-ghost" data-ingest="dismiss" type="button">忽略</button>
    </div>`
  box.dataset.text = item.text
  box.dataset.title = item.title || ''
  box.dataset.url = item.url || ''
}

/** 轮询书签推送（只在网址标签页可见时进行，避免无谓请求） */
async function pollIngest(manual = false, prime = false) {
  try {
    const res = await api.ingestLatest(state.ingestSeq)
    if (Number.isFinite(res.seq)) state.ingestSeq = res.seq
    if (prime) return // 首次只对齐序号，避免把上一次会话留下的内容又弹出来
    if (res.item) {
      renderIngestPanel(res.item)
      $('ingest-status').textContent = ''
      // 用户刚在别的页面点了书签，回到应用却停在"粘贴文本"页会以为没反应，
      // 所以主动切到网址页并把面板显示出来。
      if (!$('view-input').classList.contains('hidden')) {
        document.querySelector('.tab[data-tab="url"]').click()
      }
      toast(`收到来自浏览器的内容：${formatNumber(res.item.chars)} 字`)
    } else if (manual) {
      $('ingest-status').textContent = '暂时没有收到新内容。请确认已在协议页面上点过书签，且应用服务仍在运行。'
    }
  } catch {
    if (manual) $('ingest-status').textContent = '检查失败，请确认服务仍在运行。'
  }
}

async function startIngestPolling() {
  if (state.ingestTimer) return
  await pollIngest(false, true) // 先对齐序号
  state.ingestTimer = setInterval(() => pollIngest(false), 3000)
}

async function doFetchUrl({ allowBrowser } = {}) {
  const url = $('input-url').value.trim()
  const box = $('url-result')

  if (!url) {
    box.classList.remove('hidden')
    box.className = 'url-result is-bad'
    box.innerHTML = '<div class="ur-head">请先填写网址</div>'
    $('input-url').focus()
    return
  }

  const btn = $('btn-fetch')
  btn.disabled = true
  btn.textContent = allowBrowser ? '渲染中…' : '抓取中…'
  box.classList.remove('hidden')
  box.className = 'url-result is-busy'
  box.innerHTML = `<div class="ur-head">${
    allowBrowser ? '正在用本机浏览器渲染页面…（可能需要十几秒）' : '正在抓取页面…'
  }</div>`

  try {
    const res = await api.fetchUrl(url, { allowBrowser })
    renderUrlResult(res, url)
  } catch (err) {
    box.className = 'url-result is-bad'
    box.innerHTML = `
      <div class="ur-head">✗ 抓取失败</div>
      <p class="ur-why">${escapeHtml(err.message)}</p>
      <div class="ur-actions">
        <button class="btn btn-primary" data-act="to-text" type="button">改为手动粘贴（推荐）</button>
        <button class="btn btn-ghost" data-act="to-file" type="button">上传文件</button>
      </div>
      <p class="hint">手动粘贴：在浏览器里打开该页面 → Ctrl+A 全选 → Ctrl+C 复制 → 回到这里粘贴。</p>`
  } finally {
    btn.disabled = false
    btn.textContent = '抓取正文'
  }
}

/** 内容少于这个字数时，即便非空也认为「只是拿到了一部分」 */
const URL_USABLE_CHARS = 150

function renderUrlResult(res, url) {
  const box = $('url-result')
  const warnings = res.meta?.warnings ?? []
  const rendered = res.meta?.renderedWithBrowser
  const text = res.text ?? ''
  const len = text.trim().length

  const warnList = warnings.length
    ? `<ul class="ur-warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : ''

  const fillText = () => {
    $('input-text').value = text
    if (res.title) $('input-title').value = res.title
    state.extraction = { ...res.meta, text: undefined }
    updateTextCount()
    setExtractionMeta(res.meta, text, res.title)
  }

  // ---- 成功：内容充足 ----
  if (res.sufficient !== false && len > 0) {
    fillText()
    box.className = 'url-result is-ok'
    box.innerHTML = `
      <div class="ur-head">✓ 抓取成功　<span class="pill">${formatNumber(len)} 字</span>${
        rendered ? '<span class="pill">已用浏览器渲染</span>' : ''
      }</div>
      ${warnList}
      <div class="ur-actions">
        <button class="btn btn-primary" data-act="to-text" type="button">查看并编辑文本</button>
      </div>`
    toast(`抓取成功，共 ${formatNumber(len)} 字`)
    return
  }

  // ---- 部分成功：拿到了内容但明显不完整 ----
  // 这种情况不该说"失败"——渲染兜底常常只能救回一部分，让用户自己判断更有用。
  if (len >= URL_USABLE_CHARS) {
    fillText()
    box.className = 'url-result is-partial'
    box.innerHTML = `
      <div class="ur-head">⚠ 只抓到一部分内容　<span class="pill">${formatNumber(len)} 字</span>${
        rendered ? '<span class="pill">已用浏览器渲染</span>' : ''
      }</div>
      <p class="ur-why">可能是页面只渲染了部分章节（如需要滚动或点击展开），也可能该页确实很短。建议先核对一下再分析。</p>
      ${warnList}
      <div class="ur-actions">
        <button class="btn btn-primary" data-act="to-text" type="button">查看并核对文本</button>
        <button class="btn btn-ghost" data-act="retry" type="button">重新抓取</button>
        <button class="btn btn-ghost" data-act="to-file" type="button">上传文件</button>
      </div>
      <p class="hint">要拿到完整正文：在浏览器里打开该页面 → <kbd>Ctrl+A</kbd> 全选 → <kbd>Ctrl+C</kbd> 复制 → 回到这里粘贴。</p>`
    return
  }

  // ---- 失败：几乎没拿到东西 ----
  const canRender = state.config?.browser?.available && !rendered && state.config?.browser?.enabled !== false
  box.className = 'url-result is-bad'
  box.innerHTML = `
    <div class="ur-head">✗ 没能抓到协议正文${len ? `　<span class="pill">只拿到 ${formatNumber(len)} 字</span>` : ''}</div>
    <p class="ur-why">常见原因：正文由 JavaScript 动态渲染、需要登录、或有反爬限制。</p>
    ${warnList}
    <div class="ur-actions">
      <button class="btn btn-primary" data-act="to-text" type="button">改为手动粘贴（推荐）</button>
      ${canRender ? '<button class="btn btn-secondary" data-act="retry-browser" type="button">用本机浏览器渲染</button>' : ''}
      <button class="btn btn-ghost" data-act="retry" type="button">重新抓取</button>
      <button class="btn btn-ghost" data-act="to-file" type="button">上传文件</button>
    </div>
    <p class="hint">手动粘贴是最可靠的方式：在浏览器里打开该页面 → <kbd>Ctrl+A</kbd> 全选 → <kbd>Ctrl+C</kbd> 复制 → 回到这里粘贴。这样拿到的是浏览器渲染后的完整正文。</p>`
}

async function startAnalysis() {
  if (state.analyzing) return

  const text = $('input-text').value.trim()
  if (!text) {
    toast('请先粘贴协议正文，或上传文件 / 抓取网址', true)
    return
  }
  if (text.length < 80) {
    toast('文本太短，可能不是完整的协议内容', true)
    return
  }

  const mode = $('input-mode').value

  // 明确要求模型分析却没有密钥时，直接把用户送到设置面板，而不是给一份低质量结果
  if (mode === 'llm' && !hasAnyKey() && !state.config?.mock) {
    toast('需要先配置 API Key 才能使用模型分析', true)
    state.settings?.open()
    return
  }

  state.analyzing = true
  state.abortController = new AbortController()
  $('btn-analyze').disabled = true

  resetStages()
  showView('progress')

  let sawError = null
  try {
    const result = await api.analyzeStream(
      {
        text,
        title: $('input-title').value.trim() || undefined,
        mode,
        source: state.extraction
          ? { type: state.extraction.format ?? 'file', filename: state.extraction.filename, url: state.extraction.url }
          : { type: 'text' },
        extraction: state.extraction ? { ...state.extraction, text: undefined } : null,
      },
      {
        signal: state.abortController.signal,
        onEvent: (event) => {
          if (event.type === 'stage') updateStage(event)
          else if (event.type === 'error') sawError = event
        },
      },
    )

    finishStages()
    state.result = result
    state.view.show(result)
    state.ask?.resetAnswer()
    state.ask?.setCurrent(result, store.listHistory())
    showView('result')

    // 存历史（失败不影响主流程）
    try {
      store.saveHistory(result)
    } catch (err) {
      toast(`分析完成，但历史记录保存失败：${err.message}`, true)
    }

    if (result.stats?.mode === 'heuristic') {
      toast('已用本地规则完成分析（未调用模型）')
    } else {
      toast(`分析完成，发现 ${result.findings.length} 条风险条款`)
    }
  } catch (err) {
    if (err.name === 'AbortError' || sawError?.code === 'ABORTED') {
      toast('已取消分析')
    } else {
      toast(err.message || '分析失败', true)
      const li = document.createElement('li')
      li.className = 'is-error'
      li.innerHTML = `<span class="stage-icon">✕</span><span class="stage-text">${escapeHtml(err.message || '分析失败')}</span>`
      $('stage-list').appendChild(li)
      // 保留进度页 1.5 秒让用户看到错误，再退回输入页
      setTimeout(() => showView('input'), 1800)
    }
  } finally {
    state.analyzing = false
    state.abortController = null
    $('btn-analyze').disabled = false
  }
}

// ============================================================
// 历史记录
// ============================================================

function openHistory() {
  state.baselineHistoryId = null
  $('history-compare').classList.add('hidden')
  renderHistory()
  $('history-dialog').showModal()
}

function renderHistory() {
  const listEl = $('history-list')
  const entries = store.listHistory()

  if (entries.length === 0) {
    listEl.innerHTML = '<li class="empty-state">还没有历史记录。完成一次分析后会自动保存在这里。</li>'
    return
  }

  listEl.innerHTML = entries
    .map((e) => {
      const color = scoreColor(e.riskScore)
      const isBaseline = e.id === state.baselineHistoryId
      return `
      <li class="history-item" data-id="${e.id}">
        <div class="hi-score" style="color:${color}">${e.riskScore}</div>
        <div class="hi-main">
          <div class="hi-title">${escapeHtml(e.title)}</div>
          <div class="hi-sub">
            ${formatDate(e.savedAt)} · ${formatNumber(e.chars)} 字 · ${e.findingCount} 条风险${
              e.mode === 'heuristic' ? ' · 本地规则' : ''
            }${isBaseline ? ' · <strong>基准</strong>' : ''}
          </div>
        </div>
        <div class="hi-actions">
          <button class="btn btn-mini" data-act="open" type="button">打开</button>
          <button class="btn btn-mini" data-act="compare" type="button">${isBaseline ? '取消基准' : '对比'}</button>
          <button class="btn btn-mini btn-danger" data-act="delete" type="button">删除</button>
        </div>
      </li>`
    })
    .join('')
}

function handleHistoryClick(e) {
  const btn = e.target.closest('button[data-act]')
  if (!btn) return
  const li = btn.closest('.history-item')
  const id = li.dataset.id
  const act = btn.dataset.act

  if (act === 'delete') {
    store.deleteHistory(id)
    if (state.baselineHistoryId === id) state.baselineHistoryId = null
    $('history-compare').classList.add('hidden')
    renderHistory()
    toast('已删除该记录')
    return
  }

  if (act === 'open') {
    const entry = store.getHistory(id)
    if (!entry?.result) {
      toast('该记录内容已损坏', true)
      return
    }
    state.result = entry.result
    state.view.show(entry.result)
    state.ask?.resetAnswer()
    state.ask?.setCurrent(entry.result, store.listHistory())
    showView('result')
    $('history-dialog').close()
    toast(`已载入：${entry.title}`)
    return
  }

  if (act === 'compare') {
    if (state.baselineHistoryId === id) {
      state.baselineHistoryId = null
      $('history-compare').classList.add('hidden')
      renderHistory()
      return
    }
    if (!state.baselineHistoryId) {
      state.baselineHistoryId = id
      renderHistory()
      toast('已选择基准记录，请再点另一条的「对比」')
      return
    }
    const older = store.getHistory(state.baselineHistoryId)
    const newer = store.getHistory(id)
    if (!older || !newer) return
    // 时间较早的作为基准
    const [a, b] = new Date(older.savedAt) <= new Date(newer.savedAt) ? [older, newer] : [newer, older]
    renderCompare(store.compareEntries(a, b))
  }
}

function renderCompare(cmp) {
  const box = $('history-compare')
  const label = (id) => state.taxonomy.categories.find((c) => c.id === id)?.label ?? id
  const deltaClass = cmp.scoreDelta > 0 ? 'cmp-up' : cmp.scoreDelta < 0 ? 'cmp-down' : ''
  const deltaText = cmp.scoreDelta > 0 ? `+${cmp.scoreDelta}` : String(cmp.scoreDelta)

  box.classList.remove('hidden')
  box.innerHTML = `
    <h4>条款变化对比</h4>
    <div class="hint">
      基准：${escapeHtml(cmp.older.title)}（${formatDate(cmp.older.savedAt)}，风险分 ${cmp.older.riskScore}）
      → 新版本：${escapeHtml(cmp.newer.title)}（${formatDate(cmp.newer.savedAt)}，风险分 ${cmp.newer.riskScore}）
    </div>
    <div class="cmp-row">
      <strong>风险分变化：</strong><span class="${deltaClass}">${deltaText}</span>
    </div>
    ${
      cmp.changes.length === 0
        ? '<div class="cmp-row">未发现明显条款变化。</div>'
        : cmp.changes
            .map(
              (c) => `<div class="cmp-row">
                <span>${escapeHtml(label(c.category))}：${c.before} → ${c.after}</span>
                <span class="${c.delta > 0 ? 'cmp-up' : 'cmp-down'}">${c.delta > 0 ? `新增 ${c.delta}` : `减少 ${-c.delta}`}</span>
              </div>`,
            )
            .join('')
    }`
  state.baselineHistoryId = null
  renderHistory()
}

// ============================================================
// 划词分析
// ============================================================

let floatingBtn = null

function removeFloatingBtn() {
  floatingBtn?.remove()
  floatingBtn = null
}

function maybeShowFloatingBtn() {
  removeFloatingBtn()
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ''
  if (text.length < 150) return
  // 输入框内的选择由用户自己控制，不弹按钮
  const anchor = sel.anchorNode?.parentElement
  if (anchor?.closest('input, textarea, .doc-content, .findings-list')) return

  const rect = sel.getRangeAt(0).getBoundingClientRect()
  const btn = document.createElement('button')
  btn.className = 'btn btn-primary'
  btn.type = 'button'
  btn.textContent = `分析选中的 ${formatNumber(text.length)} 字`
  btn.style.cssText = `position:absolute;z-index:200;padding:6px 14px;font-size:13px;top:${
    window.scrollY + rect.bottom + 8
  }px;left:${window.scrollX + Math.max(8, rect.left)}px;box-shadow:var(--shadow-lg)`

  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  btn.addEventListener('click', () => {
    $('input-text').value = text
    updateTextCount()
    state.extraction = { format: 'selection', extractor: 'selection', warnings: [] }
    setExtractionMeta(null)
    removeFloatingBtn()
    showView('input')
    document.querySelector('.tab[data-tab="text"]').click()
    toast('已填入选中的文字，点击「开始分析」')
  })

  document.body.appendChild(btn)
  floatingBtn = btn
}

// ============================================================
// 初始化
// ============================================================

function bindEvents() {
  // 标签页
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t === tab)
      for (const p of document.querySelectorAll('.tab-panel')) {
        p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab)
      }
    })
  }

  // 文本输入
  $('input-text').addEventListener('input', updateTextCount)

  // 网址抓取
  $('btn-fetch').addEventListener('click', () => doFetchUrl())

  // 抓取失败面板里的操作
  $('url-result').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'to-text') {
      document.querySelector('.tab[data-tab="text"]').click()
      $('input-text').focus()
    } else if (act === 'to-file') {
      document.querySelector('.tab[data-tab="file"]').click()
    } else if (act === 'retry-browser') {
      doFetchUrl({ allowBrowser: true })
    } else if (act === 'retry') {
      doFetchUrl()
    }
  })

  // 抓取书签：把服务端报告的所有可用地址都写进去，
  // 这样即使访问方式变了（127.0.0.1 ↔ WSL IP），书签依然能用。
  const bmTargets = [location.origin, ...(state.config?.origins ?? [])]
  $('bookmarklet-link').setAttribute('href', buildBookmarklet(location.origin, bmTargets))
  const bmHint = document.getElementById('bookmarklet-targets')
  if (bmHint) bmHint.textContent = [...new Set(bmTargets)].join('　')
  $('btn-ingest-check').addEventListener('click', () => pollIngest(true))
  $('ingest-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ingest]')
    if (!btn) return
    const box = $('ingest-panel')
    if (btn.dataset.ingest === 'dismiss') {
      box.classList.add('hidden')
      return
    }
    const text = box.dataset.text ?? ''
    if (!text.trim()) return
    $('input-text').value = text
    if (box.dataset.title) $('input-title').value = box.dataset.title
    state.extraction = {
      format: 'bookmarklet',
      extractor: 'browser-bookmarklet',
      url: box.dataset.url || undefined,
      warnings: [],
    }
    updateTextCount()
    setExtractionMeta(state.extraction, text, box.dataset.title)
    box.classList.add('hidden')
    document.querySelector('.tab[data-tab="text"]').click()
    toast(`已载入 ${formatNumber(text.length)} 字，可以直接开始分析`)
  })

  // 文本框里按回车直接抓取
  $('input-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doFetchUrl()
    }
  })

  // 文件
  const dz = $('dropzone')
  dz.addEventListener('click', () => $('input-file').click())
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      $('input-file').click()
    }
  })
  $('input-file').addEventListener('change', (e) => {
    handleFiles(e.target.files)
    e.target.value = ''
  })
  for (const evt of ['dragenter', 'dragover']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault()
      dz.classList.add('is-over')
    })
  }
  for (const evt of ['dragleave', 'drop']) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault()
      if (evt === 'dragleave' && dz.contains(e.relatedTarget)) return
      dz.classList.remove('is-over')
    })
  }
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files)
  })
  // 整页拖放
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => {
    if (e.target.closest('#dropzone')) return
    e.preventDefault()
    if (e.dataTransfer?.files?.length) {
      document.querySelector('.tab[data-tab="file"]').click()
      handleFiles(e.dataTransfer.files)
    }
  })

  // 动作
  $('btn-analyze').addEventListener('click', startAnalysis)
  $('btn-clear').addEventListener('click', () => {
    $('input-text').value = ''
    $('input-url').value = ''
    $('input-title').value = ''
    $('file-list').innerHTML = ''
    state.extraction = null
    setExtractionMeta(null)
    updateTextCount()
  })
  $('btn-cancel').addEventListener('click', () => {
    state.abortController?.abort()
  })
  $('btn-new').addEventListener('click', () => {
    state.result = null
    showView('input')
  })
  $('btn-restart').addEventListener('click', () => showView('input'))

  // 导出
  $('btn-export-md').addEventListener('click', () => {
    if (!state.result) return
    const md = toMarkdown(state.result, state.taxonomy)
    downloadText(safeFilename(state.result.doc?.title), md)
    toast('已导出 Markdown 报告')
  })
  $('btn-print').addEventListener('click', () => window.print())

  // 历史
  $('btn-history').addEventListener('click', openHistory)
  $('btn-history-close').addEventListener('click', () => $('history-dialog').close())
  $('history-list').addEventListener('click', handleHistoryClick)
  $('btn-history-clear').addEventListener('click', () => {
    if (!confirm('确定要清空全部历史记录吗？此操作不可撤销。')) return
    store.clearHistory()
    state.baselineHistoryId = null
    $('history-compare').classList.add('hidden')
    renderHistory()
    toast('历史记录已清空')
  })

  // 划词
  document.addEventListener('mouseup', () => setTimeout(maybeShowFloatingBtn, 10))
  document.addEventListener('mousedown', (e) => {
    if (floatingBtn && !e.target.closest('button')) removeFloatingBtn()
  })
  document.addEventListener('scroll', removeFloatingBtn, { passive: true })

  // 模型设置
  $('btn-settings').addEventListener('click', () => state.settings?.open())
  $('status').addEventListener('click', () => state.settings?.open())
  $('btn-key-banner').addEventListener('click', () => state.settings?.open())

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!$('view-input').classList.contains('hidden')) startAnalysis()
    }
    if (e.key === 'Escape') removeFloatingBtn()
  })
}

function createView() {
  state.view = createResultView(
    {
      resultTitle: $('result-title'),
      resultMeta: $('result-meta'),
      resultWarnings: $('result-warnings'),
      scoreValue: $('score-value'),
      scoreVerdict: $('score-verdict'),
      ringFg: $('ring-fg'),
      severityCounts: $('severity-counts'),
      reportSummary: $('report-summary'),
      reportReadability: $('report-readability'),
      cardTop: $('card-top'),
      topConcerns: $('top-concerns'),
      cardCategories: $('card-categories'),
      categorySummary: $('category-summary'),
      cardActions: $('card-actions'),
      reportActions: $('report-actions'),
      cardPositives: $('card-positives'),
      reportPositives: $('report-positives'),
      resultStats: $('result-stats'),
      findingsCount: $('findings-count'),
      findingsSearch: $('findings-search'),
      severityFilter: $('severity-filter'),
      filterHidden: $('filter-hidden'),
      findingsList: $('findings-list'),
      resultTabs: $('result-tabs'),
      docCol: document.querySelector('.doc-col'),
      digestList: $('digest-list'),
      digestCount: $('digest-count'),
      interactionsList: $('interactions-list'),
      interactionsCount: $('interactions-count'),
      docContent: $('doc-content'),
      docTruncated: $('doc-truncated'),
      toggleHighlight: $('toggle-highlight'),
      btnFontUp: $('btn-font-up'),
      btnFontDown: $('btn-font-down'),
    },
    state.taxonomy,
  )
}

function createSettings() {
  state.settings = createSettingsPanel({
    dom: {
      dialog: $('settings-dialog'),
      setKey: $('set-key'),
      setBaseUrl: $('set-base-url'),
      setModel: $('set-model'),
      setModelSummary: $('set-model-summary'),
      setRemember: $('set-remember'),
      btnToggleKey: $('btn-toggle-key'),
      btnTestKey: $('btn-test-key'),
      btnSettingsSave: $('btn-settings-save'),
      btnSettingsClear: $('btn-settings-clear'),
      btnSettingsClose: $('btn-settings-close'),
      settingsStatus: $('settings-status'),
      modelSuggestions: $('model-suggestions'),
    },
    onSaved: (creds) => applyCredentials(creds),
    serverHasKey: () => Boolean(state.config?.hasApiKey),
    toast,
  })
  state.settings.setModelSuggestions(state.modelSuggestions)
}

/**
 * 根据运行模式调整界面。
 *
 * 纯静态站点（GitHub Pages）有几个功能受浏览器沙箱限制做不到，
 * 与其让用户点了报错，不如**提前说清楚**：
 *   - 抓取网页 / 联网搜索：跨域限制
 *   - 抓取书签：它需要一个本地服务来接收推送
 *   - PDF / DOCX：依赖垫片，垫片缺失时禁用
 */
function applyModeUi() {
  const isStatic = state.mode === 'static'
  document.body.classList.toggle('mode-static', isStatic)

  const note = $('mode-note')
  if (note) {
    if (isStatic) {
      note.classList.remove('hidden')
      const caps = state.capabilities ?? {}
      const missing = []
      if (!caps.shim) missing.push('PDF / Word 解析')
      const limited = ['抓取网页', '联网搜索'].concat(missing)
      note.innerHTML = `
        <strong>纯静态模式</strong>
        <span>
          所有分析都在你的浏览器里完成，<strong>协议文本与密钥直接发往 DeepSeek，不经过任何第三方服务器</strong>。
          受浏览器安全策略限制，以下功能在此模式下不可用：${limited.join('、')}。
          需要它们的话，可以在本机运行服务端版本（<code>node server.js</code>）。
        </span>`
    } else {
      note.classList.add('hidden')
    }
  }

  // 静态模式下书签没有接收方，直接藏掉，避免用户白折腾
  const bm = document.querySelector('.bookmarklet-box')
  if (bm) bm.classList.toggle('hidden', isStatic)

  // 抓取标签页给个说明
  const urlPanel = document.querySelector('.tab-panel[data-panel="url"]')
  if (urlPanel) {
    const tip = $('url-static-tip')
    if (tip) tip.classList.toggle('hidden', !isStatic)
  }
}

function createAsk() {
  state.ask = createAskPanel({
    dom: {
      askQuestion: $('ask-question'),
      askSubmit: $('ask-submit'),
      askWeb: $('ask-web'),
      askSuggest: $('ask-suggest'),
      askStatus: $('ask-status'),
      askAnswer: $('ask-answer'),
      askHistory: $('ask-history'),
      askCorpusSummary: $('ask-corpus-summary'),
      askCorpusList: $('ask-corpus-list'),
      askCorpusPanel: $('ask-corpus-panel'),
      btnAskCorpus: $('btn-ask-corpus'),
    },
    // 点证据 → 切到「原文对照」并高亮该条款
    onLocate: (clauseId) => state.view?.focusClause(clauseId),
    // 提问前先判断有没有 Key：没有就直说，别让它变成"服务坏了"的假象
    hasKey: () => Boolean(state.credentials?.apiKey) || Boolean(state.config?.hasApiKey),
    openSettings: () => state.settings?.open(),
    toast,
  })
}

const CONSENT_KEY = 'agreement-reader:consent:v1'

/** 首次使用须知：只在用户确认过一次之前显示 */
function setupConsent() {
  const banner = $('consent-banner')
  if (!banner) return
  let agreed = false
  try {
    agreed = localStorage.getItem(CONSENT_KEY) === '1'
  } catch {
    /* 隐私模式下读不到，那就每次都显示，宁可多提示 */
  }
  if (agreed) return

  banner.classList.remove('hidden')
  $('btn-consent-ok').addEventListener('click', () => {
    try {
      localStorage.setItem(CONSENT_KEY, '1')
    } catch {
      /* 存不了也不影响使用 */
    }
    banner.classList.add('hidden')
  })
}

/**
 * 检查是否连到了旧版服务。
 *
 * 这个检查是踩坑补上的：本地可能同时存在两份服务（Windows 原生 + WSL，
 * 两个网络命名空间互不冲突），浏览器连到哪一份取决于你怎么访问。
 * 连到旧的那份时，页面是新功能、接口却是旧实现 —— 表现为
 * 「点提问没反应」「字段缺失」「未知接口」这类极难排查的现象。
 *
 * 与其让人猜，不如让程序直接说出来。
 */
async function checkServerVersion() {
  let health = null
  try {
    health = await api.checkHealth()
  } catch {
    return // 连不上另有提示，这里不重复
  }

  const banner = $('version-banner')
  if (!banner) return

  const theirs = health.apiVersion
  const ok = theirs === EXPECTED_API_VERSION

  // 旧服务连 apiVersion 字段都没有，更要提醒
  const isAncient = theirs === undefined
  if (ok) {
    banner.classList.add('hidden')
    return
  }

  banner.classList.remove('hidden')
  banner.innerHTML = `
    <div>
      <strong>⚠ 你连接的服务是旧版本${isAncient ? '（旧到没有版本信息）' : `（接口 v${theirs}，需要 v${EXPECTED_API_VERSION}）`}</strong>
      <span>
        这就是「点了没反应」「未知接口」「诊断信息缺失」这类现象的根源 ——
        页面是新功能，后端却是改动前的进程。
        本地可能同时跑着两份服务（Windows 原生与 WSL 各一份，互不冲突）。
      </span>
      <span class="version-hint">
        当前连到：<code>${escapeHtml(location.origin)}</code>
        ${health.platform ? `　进程平台：<code>${escapeHtml(health.platform)}</code>` : ''}
        ${health.pid ? `　PID：<code>${health.pid}</code>` : ''}
        ${health.version ? `　服务版本：<code>${escapeHtml(health.version)}</code>` : ''}
      </span>
      <span><strong>处理办法：</strong>双击 <code>停止.cmd</code> 停掉所有服务，再双击 <code>启动.cmd</code> 重新启动。</span>
    </div>`
}

function createLegal() {
  state.legal = createLegalPanel({
    dom: {
      dialog: $('legal-dialog'),
      legalTitle: $('legal-title'),
      legalBody: $('legal-body'),
      btnClose: $('btn-legal-close'),
    },
    toast,
  })
}

async function init() {
  bindEvents()
  updateTextCount()
  resetStages()

  // 先取配置（含分类体系与模型建议），再创建各视图——
  // 渲染器会在创建时缓存分类映射，顺序颠倒会导致类别只显示英文 id。
  try {
    const cfg = await api.getConfig()
    state.config = cfg.config
    state.modelSuggestions = cfg.models?.suggestions ?? []
    state.mode = cfg.mode ?? (await api.resolveMode())
    if (cfg.taxonomy) {
      state.taxonomy = cfg.taxonomy
    } else {
      // 纯静态模式：没有服务端下发分类体系，直接从本地模块取同一份定义
      const tax = await import('../src/analyze/taxonomy.js')
      state.taxonomy = {
        categories: tax.CATEGORIES.map((c) => ({ id: c.id, label: c.label, group: c.group, what: c.what, why: c.why })),
        severityLabels: tax.SEVERITY_LABEL,
        severities: tax.SEVERITIES,
      }
    }
    state.capabilities = cfg.capabilities ?? null
    applyModeUi()
  } catch (err) {
    state.configFailed = true
    state.configError = err.message
    toast(`无法连接后端服务：${err.message}`, true)
  }

  createView()
  createSettings()
  createAsk()
  createLegal()
  setupConsent()
  startIngestPolling()
  checkServerVersion()

  // 载入用户此前保存的密钥并立即生效
  applyCredentials(loadCredentials())
}

init()
