/**
 * 静态构建可达性检查。
 *
 * 纯静态站点最容易出的问题不是代码错，而是**某个文件没被构建进去** ——
 * 部署后表现为 404，而且往往只在用户点开某个功能时才暴露。
 *
 * 这里从 index.html 出发，递归跟随所有 ES 模块 import（含动态 import('...')），
 * 逐个请求，确认都能拿到 200。CI 里会在部署前跑这一步。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, '_site')

if (!fs.existsSync(SITE)) {
  console.error('没有 _site/，请先运行：npm run build:static')
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const target = path.resolve(SITE, '.' + (rel === '/' ? '/index.html' : rel))
  if (!target.startsWith(SITE) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404).end('404')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream' })
  res.end(fs.readFileSync(target))
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

/** 从一个 JS 源码里抽出所有 import 目标 */
function importsOf(src) {
  const out = new Set()
  // import ... from '...'   /   export ... from '...'
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g)) out.add(m[1])
  // 裸 import '...'
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.add(m[1])
  // 动态 import('...')
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1])
  return [...out]
}

function resolvePath(fromUrl, spec) {
  if (!spec) return null
  // 带协议的都跳过：http(s) 外链、data:、javascript:、blob: 等
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null
  if (spec.startsWith('//')) return null // 协议相对的外链
  if (spec.startsWith('/')) return spec
  return new URL(spec, `http://x${fromUrl}`).pathname
}

const visited = new Map() // path -> status
const missing = []
const queue = []

// 1) 从 HTML 里找入口
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) queue.push(resolvePath('/index.html', m[1]))
for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) {
  const p = resolvePath('/index.html', m[1])
  if (p) queue.push(p)
}

// 2) 递归跟随
while (queue.length) {
  const p = queue.shift()
  if (!p || visited.has(p)) continue

  const res = await fetch(base + p)
  visited.set(p, res.status)
  if (!res.ok) {
    missing.push({ path: p, status: res.status })
    continue
  }

  if (!/\.(js|mjs)$/.test(p)) continue
  const src = await res.text()
  for (const spec of importsOf(src)) {
    const next = resolvePath(p, spec)
    if (next && !visited.has(next)) queue.push(next)
  }
}

server.close()

// 3) 汇总
const okCount = [...visited.values()].filter((s) => s === 200).length
console.log(`静态构建可达性检查`)
console.log(`  已检查：${visited.size} 个资源，${okCount} 个正常`)
if (missing.length) {
  console.log(`  缺失：`)
  for (const m of missing) console.log(`    ✗ ${m.path}（HTTP ${m.status}）`)
  process.exit(1)
}
console.log('  ✓ 所有模块都能解析，部署后不会出现 404')

// 4) 额外断言：关键文件确实在产物里
const required = ['/index.html', '/js/app.js', '/js/api.js', '/js/engine.js', '/src/analyze/pipeline.js', '/src/config.js']
const absent = required.filter((r) => !visited.has(r) && !fs.existsSync(path.join(SITE, r)))
if (absent.length) {
  console.log('  缺少关键文件：')
  for (const a of absent) console.log(`    ✗ ${a}`)
  process.exit(1)
}
console.log('  ✓ 关键文件齐全')
