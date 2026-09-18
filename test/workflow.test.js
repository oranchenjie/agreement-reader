/**
 * GitHub Pages 部署工作流的静态校验。
 *
 * 存在的理由：workflow 是**本地跑不到的一层**。`server.js`、`public/`、
 * 分析流水线都有测试兜着，但 `.github/workflows/*.yml` 只有在推上去之后
 * 才会真正执行——写错一个 npm script 名、artifact 路径对不上构建产物、
 * 少声明一个权限，都要等 Actions 跑完才知道。
 *
 * 这套检查就是被一次真实事故逼出来的：线上 build job 跑完测试和构建后，
 * 卡在 `actions/configure-pages` 上以
 * 「Get Pages site failed ... Not Found」失败，
 * 而本地完全复现不了。事后确认这一步对本项目毫无用处（它唯一产出
 * base_path，而 base_path 就是 /<仓库名>，一行能算出来），
 * 却能在「Pages 站点尚未建立」时把整个部署卡死。
 *
 * 所以这里把几条踩过的教训固化成断言：
 *
 *   1. workflow 里 `npm run X` / `npm test` 引用的脚本必须真实存在
 *   2. 上传的 artifact 路径必须等于构建脚本实际产出的目录
 *   3. 不再依赖 configure-pages（它会在 Pages 未就绪时硬失败）
 *   4. 子路径必须由 github.event.repository.name 推导，不能写死仓库名
 *      —— 否则改仓库名或换自定义域名就会 404
 *   5. deploy-pages 需要的权限必须在 workflow 里显式声明
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'deploy-pages.yml')

const raw = fs.readFileSync(WORKFLOW, 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** 去掉注释行，避免把「说明文字」当成「实际配置」来断言 */
const code = raw
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')

test('workflow：文件存在且是 UTF-8 文本', () => {
  assert.ok(raw.length > 0, 'deploy-pages.yml 不能为空')
  assert.ok(raw.includes('name:'), '应是一份 workflow 定义')
})

test('workflow：引用的 npm 脚本都真实存在', () => {
  const referenced = new Set()
  for (const m of code.matchAll(/\bnpm run ([a-zA-Z][\w:-]*)/g)) referenced.add(m[1])
  for (const m of code.matchAll(/\bnpm (test)\b/g)) referenced.add(m[1])

  assert.ok(referenced.size > 0, '至少应引用一个 npm 脚本')
  for (const name of referenced) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(pkg.scripts, name),
      `workflow 引用了 package.json 里不存在的脚本：npm run ${name}`
    )
  }
})

test('workflow：完整跑了测试、构建、可达性检查三步', () => {
  // 少任何一步，坏掉的产物都可能被直接发布出去
  assert.match(code, /\bnpm test\b/, '必须跑测试')
  assert.match(code, /npm run build:static/, '必须构建静态站点')
  assert.match(code, /npm run check:static/, '必须检查产物可达性')

  // 顺序也要对：检查必须在构建之后、上传之前
  const iBuild = code.indexOf('npm run build:static')
  const iCheck = code.indexOf('npm run check:static')
  const iUpload = code.indexOf('upload-pages-artifact')
  assert.ok(iBuild < iCheck, '可达性检查必须在构建之后')
  assert.ok(iCheck < iUpload, '可达性检查必须在上传之前，否则等于没查')
})

test('workflow：上传的 artifact 路径与构建产物目录一致', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-static.mjs'), 'utf8')
  const m = build.match(/const OUT = path\.join\(ROOT,\s*'([^']+)'\)/)
  assert.ok(m, '未能从 build-static.mjs 解析出产物目录')

  const uploadMatch = code.match(/uses:\s*actions\/upload-pages-artifact@\S+\s*\n\s*with:\s*\n\s*path:\s*(\S+)/)
  assert.ok(uploadMatch, '未找到 upload-pages-artifact 的 path 配置')
  assert.equal(
    uploadMatch[1],
    m[1],
    `上传路径(${uploadMatch[1]})与构建产物目录(${m[1]})不一致，部署出来会是空站点`
  )
})

test('workflow：不再依赖 actions/configure-pages', () => {
  // 它是上一次真实故障的根因：Pages 站点尚未建立时返回 Not Found 并让整个 job 失败。
  // 本项目构建产物是相对路径的，不需要注入 base_path，所以直接用仓库名推导即可。
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  assert.ok(
    !uses.some((u) => u.includes('configure-pages')),
    'configure-pages 会在 Pages 未就绪时硬失败，且对本项目无用，不应重新引入'
  )
  assert.ok(uses.includes('actions/upload-pages-artifact@v3'), '缺少 upload-pages-artifact')
  assert.ok(uses.includes('actions/deploy-pages@v4'), '缺少 deploy-pages')
})

test('workflow：子路径由仓库名推导，没有写死仓库名', () => {
  // 写死 /agreement-reader 的话，改仓库名或加自定义域名后
  // check:static 会去检查一个不存在的路径。
  assert.match(
    code,
    /BASE_PATH:\s*\/\$\{\{\s*github\.event\.repository\.name\s*\}\}/,
    'BASE_PATH 应由 github.event.repository.name 推导'
  )
  assert.ok(
    !code.includes('agreement-reader'),
    'workflow 里不应出现写死的仓库名'
  )
})

test('workflow：deploy-pages 所需权限已声明', () => {
  assert.match(code, /pages:\s*write/, '缺少 pages: write')
  assert.match(code, /id-token:\s*write/, '缺少 id-token: write（OIDC 部署需要）')
  assert.match(code, /contents:\s*read/, '缺少 contents: read')
})

test('workflow：deploy job 依赖 build，且触发分支包含默认分支', () => {
  assert.match(code, /needs:\s*build/, 'deploy 必须依赖 build，否则可能发布未测试的产物')
  assert.match(code, /branches:\s*\[[^\]]*\bmain\b[^\]]*\]/, 'push 触发分支必须包含 main')
})

test('workflow：部署到 github-pages 环境并暴露 page_url', () => {
  assert.match(code, /name:\s*github-pages/, 'deploy 应绑定 github-pages 环境')
  assert.match(code, /steps\.deployment\.outputs\.page_url/, '应输出 page_url 便于回看')
})
