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

/**
 * 模拟 GitHub Pages 的**子路径**部署。
 *
 * 这一点很关键：GitHub Pages 的项目站点是挂在
 * `https://<用户>.github.io/<仓库名>/` 下的，而不是域名根目录。
 * 如果本地预览跑在根目录，就会漏掉一类致命 bug ——
 * 代码里写了 `/src/...` 这种站点根绝对路径，本地一切正常，
 * 部署后却全部 404（真实踩过）。
 *
 * 所以这里默认也挂在子路径下，与线上保持一致。
 */
const BASE_PATH = (process.env.BASE_PATH ?? '/agreement-reader').replace(/\/+$/, '')

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

    // 根路径跳转到子路径，方便直接点开
    if (rel === '/' || rel === BASE_PATH) {
      res.writeHead(302, { Location: `${BASE_PATH}/` }).end()
      return
    }
    // 不在子路径下的请求一律 404 —— 与 GitHub Pages 行为一致，
    // 这样任何"/src/..."式的根绝对路径都会在这里暴露出来
    if (!rel.startsWith(BASE_PATH + '/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found')
      return
    }
    rel = rel.slice(BASE_PATH.length)
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
    console.log(`  ➜  http://127.0.0.1:${PORT}${BASE_PATH}/`)
    console.log('')
    console.log(`  注意：挂在子路径 ${BASE_PATH}/ 下，与 GitHub Pages 项目站点一致。`)
    console.log('')
    console.log('  页面会显示「纯静态模式」提示。填入 API Key 后即可完整使用分析功能。')
    console.log('')
  })
