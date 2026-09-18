/**
 * 历史记录存储（localStorage）。
 *
 * 隐私设计：结果只留在用户自己的浏览器里，服务端不落库。
 * 容量设计：localStorage 通常只有 5MB，而一份长协议的结果可能很大，
 * 因此这里对正文做截断、限制条目数，并在配额不足时自动淘汰最旧记录重试。
 */

const KEY = 'agreement-reader:history:v1'
const MAX_ENTRIES = 12
/**
 * 单份记录保留的正文上限。
 * 之前是 12 万字 —— 实测发现长协议被截断后，**超出部分的条款会整段消失**，
 * 问答时那些条款就检索不到，表现为"协议里没写"。现在放宽，同时减少保留份数。
 */
const MAX_DOC_CHARS = 400_000

function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(entries) {
  // 先尝试整体写入，配额不足时逐步淘汰最旧记录
  let list = entries.slice(0, MAX_ENTRIES)
  for (let attempt = 0; attempt < MAX_ENTRIES; attempt++) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list))
      return list
    } catch (err) {
      if (list.length <= 1) {
        // 单条都放不下：存一份不含正文的极简版
        try {
          const slim = list.map((e) => ({ ...e, result: { ...e.result, doc: { ...e.result.doc, text: '' } } }))
          localStorage.setItem(KEY, JSON.stringify(slim))
          return slim
        } catch {
          throw new Error('浏览器存储空间不足，无法保存历史记录。')
        }
      }
      list = list.slice(0, Math.max(1, list.length - 1))
    }
  }
  return list
}

/** 精简结果后再存储，避免把整篇原文都塞进 localStorage */
function slimResult(result) {
  const text = result?.doc?.text ?? ''
  return {
    ...result,
    doc: {
      ...result.doc,
      text: text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text,
      textTruncated: text.length > MAX_DOC_CHARS,
    },
  }
}

export function listHistory() {
  return readAll().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
}

export function saveHistory(result, extra = {}) {
  const entry = {
    id: result.id,
    savedAt: new Date().toISOString(),
    title: result.doc?.title || extra.title || '未命名协议',
    source: result.source ?? { type: 'text' },
    riskScore: result.report?.riskScore ?? 0,
    verdict: result.report?.verdict ?? '',
    findingCount: result.findings?.length ?? 0,
    severityCounts: countSeverities(result.findings ?? []),
    mode: result.stats?.mode ?? 'llm',
    chars: result.doc?.chars ?? 0,
    clauseCount: result.doc?.clauseCount ?? 0,
    tags: result.findings?.slice(0, 40).map((f) => ({ category: f.category, severity: f.severity })) ?? [],
    result: slimResult(result),
  }

  const list = readAll().filter((e) => e.id !== entry.id)
  list.unshift(entry)
  writeAll(list)
  return entry
}

export function deleteHistory(id) {
  const list = readAll().filter((e) => e.id !== id)
  writeAll(list)
  return list
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}

export function getHistory(id) {
  return readAll().find((e) => e.id === id) ?? null
}

function countSeverities(findings) {
  const acc = {}
  for (const f of findings) acc[f.severity] = (acc[f.severity] ?? 0) + 1
  return acc
}

/**
 * 对比两份记录：风险分变化 + 各类别增减。
 * 用途：同一份协议改版后，快速看出平台把哪些条款改得更苛刻了。
 */
export function compareEntries(a, b) {
  const catCount = (entry) => {
    const acc = {}
    for (const f of entry.result?.findings ?? []) acc[f.category] = (acc[f.category] ?? 0) + 1
    return acc
  }
  const ca = catCount(a)
  const cb = catCount(b)
  const ids = new Set([...Object.keys(ca), ...Object.keys(cb)])

  const changes = []
  for (const id of ids) {
    const before = ca[id] ?? 0
    const after = cb[id] ?? 0
    if (before !== after) changes.push({ category: id, before, after, delta: after - before })
  }
  changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))

  return {
    older: a,
    newer: b,
    scoreDelta: (b.riskScore ?? 0) - (a.riskScore ?? 0),
    changes,
  }
}
