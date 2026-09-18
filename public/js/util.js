/** 通用小工具 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatNumber(n) {
  const num = Number(n ?? 0)
  if (!Number.isFinite(num)) return '0'
  return num.toLocaleString('zh-CN')
}

export function formatDuration(ms) {
  const n = Number(ms ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1000) return `${Math.round(n)} 毫秒`
  if (n < 60_000) return `${(n / 1000).toFixed(1)} 秒`
  const m = Math.floor(n / 60_000)
  const s = Math.round((n % 60_000) / 1000)
  return `${m} 分 ${s} 秒`
}

export function formatDate(iso) {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

export function formatBytes(bytes) {
  const n = Number(bytes ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function debounce(fn, wait = 200) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/** 按分数返回风险配色 */
export function scoreColor(score) {
  const s = Number(score ?? 0)
  if (s <= 20) return '#16a34a'
  if (s <= 45) return '#0284c7'
  if (s <= 70) return '#d97706'
  return '#dc2626'
}
