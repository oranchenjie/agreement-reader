/**
 * zlib 的同构适配层。
 *
 * - Node：用内置的 `node:zlib`（原生实现，快）
 * - 浏览器：用自研的纯 JS 同步 inflate（`public/js/browser-shim.js`）
 *   —— 浏览器虽有 `DecompressionStream`，但它是**异步**的，
 *   而 PDF/ZIP 解析是同步流程，改不动，所以只能自带一个同步解码器。
 *
 * 用**顶层 await 动态 import**：静态 `import 'node:zlib'` 会让整个模块
 * 在浏览器里直接加载失败（即使代码路径走不到）。
 */
const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node)

// 浏览器端用相对路径引用垫片。构建后的布局是：
//   _site/js/browser-shim.js   ← 垫片
//   _site/src/extract/zlib-compat.js  ← 本文件，所以 ../../js/ 正好指回 js/
// 不能用 `/js/...`：GitHub Pages 项目站点挂在子路径下，站点根绝对路径会 404。
const impl = isNode ? await import('node:zlib') : await import('../../js/browser-shim.js')

/** 兼容两种导出形态：node:zlib 是具名导出，垫片额外提供 zlib 命名空间 */
const src = impl.zlib ?? impl

export const inflateSync = src.inflateSync
export const inflateRawSync = src.inflateRawSync
export const constants = src.constants ?? impl.constants ?? {}

export default { inflateSync, inflateRawSync, constants }
