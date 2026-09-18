/**
 * 生成唯一 id（同构）。
 *
 * 原本直接用 `node:crypto` 的 randomUUID —— 那是静态 import，
 * 会让整个模块在浏览器里加载失败。这里用全局 `crypto`：
 * Node 19+ 与所有现代浏览器都自带，无需任何依赖。
 */
export function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  if (globalThis.crypto?.getRandomValues) {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  // 最后的兜底：不追求密码学强度，只保证不撞
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
