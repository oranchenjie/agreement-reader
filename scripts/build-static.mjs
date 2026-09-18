/**
 * 构建纯静态站点到 `_site/`。
 *
 * 为什么需要"构建"这一步（而不是直接把仓库根当站点）：
 * 静态站点需要两份东西同时位于站点根下 ——
 *   1. `public/` 里的前端（index.html / js / css / legal）
 *   2. `src/` 里的共享逻辑（分析流水线、检索、核验……）
 * 前端通过**站点根绝对路径** `/src/...` 引用后者，这样在
 * 「本机服务端托管 public/」与「静态站点托管 _site/」两种布局下都能解析。
 *
 * GitHub Pages 直接从 `_site/` 发布。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '_site')

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true })
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  // 1) 前端
  copy(path.join(ROOT, 'public'), OUT)

  // 2) 共享逻辑（前端用 /src/... 绝对路径引用）
  copy(path.join(ROOT, 'src'), path.join(OUT, 'src'))

  // 3) 文档与许可证
  copy(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'))
  copy(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'))

  // 4) GitHub Pages 默认会跑 Jekyll，它忽略下划线开头的文件。
  //    放一个 .nojekyll 关掉，保证所有资源都能正常访问。
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '')

  // 5) 打印清单，便于确认
  const count = (dir) => {
    let n = 0
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      n += e.isDirectory() ? count(path.join(dir, e.name)) : 1
    }
    return n
  }
  const size = (dir) => {
    let b = 0
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) b += size(p)
      else b += fs.statSync(p).size
    }
    return b
  }

  const files = count(OUT)
  const bytes = size(OUT)
  console.log('静态站点已生成：_site/')
  console.log(`  文件数：${files}`)
  console.log(`  体积  ：${(bytes / 1024).toFixed(0)} KB`)
  console.log('')
  console.log('  本地预览：npm run preview:static')
  console.log('  部署     ：推送到 GitHub 后由 Actions 自动发布到 Pages')
}

main()
