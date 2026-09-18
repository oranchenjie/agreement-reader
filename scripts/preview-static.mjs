/**
 * 本地预览静态构建产物（`_site/`），用于在推送前验证纯静态模式是否正常。
 *
 * 刻意**不提供任何 /api 接口** —— 这样前端探测不到后端，就会切到本地引擎模式，
 * 与 GitHub Pages 上的真实行为完全一致。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, '_site')
const PORT = Number(process.env.PORT) || 8080

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
}

if (!fs.existsSync(SITE)) {
  console.error('还没有构建产物。请先运行：npm run build:static')
  process.exit(1)
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/') rel = '/index.html'

    const target = path.resolve(SITE, '.' + rel)
    if (!target.startsWith(SITE)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found')
      return
    }
    if (stat.isDirectory()) {
      res.writeHead(302, { Location: rel.replace(/\/?$/, '/') + 'index.html' }).end()
      return
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(target).pipe(res)
  })
  .listen(PORT, () => {
    console.log('')
    console.log('  静态站点预览（纯前端模式，没有后端接口）')
    console.log(`  ➜  http://127.0.0.1:${PORT}`)
    console.log('')
    console.log('  页面会显示「纯静态模式」提示。填入 API Key 后即可完整使用分析功能。')
    console.log('')
  })
