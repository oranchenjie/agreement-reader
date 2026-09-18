/**
 * 从模型回复中稳健地抽出 JSON。
 *
 * 现实情况：即使要求「只输出 JSON」，模型仍可能加 markdown 围栏、加解释性前后缀、
 * 用中文全角引号、留尾随逗号，或因 max_tokens 截断而输出不完整 JSON。
 * 这里逐级降级处理，尽量把可用信息捞回来，而不是直接报错。
 */

/** 去掉 markdown 代码围栏与常见前缀 */
function stripFences(text) {
  let t = String(text ?? '').replace(/^\uFEFF/, '').trim()
  // ```json ... ``` / ``` ... ```
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(t)
  if (fence) t = fence[1].trim()
  // 残留的单侧围栏
  t = t.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```\s*$/, '').trim()
  return t
}

/**
 * 扫描出第一个「字符串感知 + 括号平衡」的 JSON 片段。
 * 能正确跳过字符串内部的花括号与转义字符。
 */
function sliceBalanced(text) {
  const startIdx = (() => {
    const a = text.indexOf('{')
    const b = text.indexOf('[')
    if (a === -1) return b
    if (b === -1) return a
    return Math.min(a, b)
  })()
  if (startIdx === -1) return null

  const open = text[startIdx]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(startIdx, i + 1)
    }
  }
  // 未闭合：返回剩余部分，交给 salvage 处理
  return text.slice(startIdx)
}

/** 常见格式问题的确定性修复 */
function applyRepairs(text) {
  let t = text
  // 全角引号当定界符（模型偶尔会这样写）→ 仅在明显是键/值定界时替换
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  // 去行注释与块注释（JSON 不允许）
  t = t.replace(/^\s*\/\/.*$/gm, '')
  t = t.replace(/\/\*[\s\S]*?\*\//g, '')
  // 尾随逗号
  t = t.replace(/,(\s*[}\]])/g, '$1')
  // 字符串内的裸换行 → \n（逐字符扫描，避免破坏结构）
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of t) {
    if (inStr) {
      if (esc) {
        out += ch
        esc = false
        continue
      }
      if (ch === '\\') {
        out += ch
        esc = true
        continue
      }
      if (ch === '"') {
        inStr = false
        out += ch
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') continue
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inStr = true
    out += ch
  }
  // 单引号键/值 → 双引号（较保守：仅处理 'key': 与 : 'value'）
  out = out.replace(/'([^'\\]*)'(\s*:)/g, '"$1"$2')
  return out
}

/** 截断恢复：把已完整的数组元素逐个捞出 */
export function salvageArrayItems(text, key) {
  const items = []
  const keyIdx = text.indexOf(`"${key}"`)
  if (keyIdx === -1) return items
  const arrStart = text.indexOf('[', keyIdx)
  if (arrStart === -1) return items

  let i = arrStart + 1
  while (i < text.length) {
    // 找下一个对象起点
    while (i < text.length && text[i] !== '{') {
      if (text[i] === ']') return items
      i++
    }
    if (i >= text.length) break
    // 从这个 { 开始做平衡扫描
    let depth = 0
    let inStr = false
    let esc = false
    let j = i
    let closed = false
    for (; j < text.length; j++) {
      const ch = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          closed = true
          j++
          break
        }
      }
    }
    if (!closed) break
    const fragment = text.slice(i, j)
    try {
      items.push(JSON.parse(applyRepairs(fragment)))
    } catch {
      /* 跳过坏对象 */
    }
    i = j
  }
  return items
}

/**
 * 主入口：从任意文本中解析出 JSON 对象。
 * @param {string} text
 * @param {{ salvageKey?: string, warnings?: string[] }} [opts]
 * @returns {any}
 * @throws {Error} 完全无法解析时抛出
 */
export function parseModelJson(text, opts = {}) {
  const warnings = opts.warnings ?? []
  const stripped = stripFences(text)
  if (!stripped) throw new Error('模型返回为空')

  // 一级：直接解析
  try {
    return JSON.parse(stripped)
  } catch {
    /* 继续降级 */
  }

  // 二级：切出平衡片段
  const sliced = sliceBalanced(stripped)
  if (sliced) {
    try {
      return JSON.parse(sliced)
    } catch {
      /* 继续 */
    }
    // 三级：确定性修复
    try {
      return JSON.parse(applyRepairs(sliced))
    } catch {
      /* 继续 */
    }
    // 四级：截断恢复
    if (opts.salvageKey) {
      const items = salvageArrayItems(sliced, opts.salvageKey)
      if (items.length) {
        warnings.push(`模型输出疑似被截断，已从「${opts.salvageKey}」中恢复 ${items.length} 条完整记录。`)
        return { [opts.salvageKey]: items, __salvaged: true }
      }
    }
  }

  throw new Error(`无法从模型输出中解析 JSON（前 200 字符：${stripped.slice(0, 200)}）`)
}

/** 尝试把任意值规整成数组 */
export function asArray(v) {
  if (Array.isArray(v)) return v
  if (v == null) return []
  return [v]
}
