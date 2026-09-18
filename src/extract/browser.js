/**
 * 用本机已安装的 Chrome / Edge 做无头渲染，拿到 JavaScript 执行后的 DOM。
 *
 * 为什么需要它：现在大量网站（尤其国内的隐私政策 / 用户协议页）是前端渲染的 SPA，
 * 静态 HTML 里只有 `<div id="app"></div>`，正文全靠 JS 拉取后插入。
 * 这种情况无论 HTML 解析算法多好都提取不到内容，唯一的通用解法是真正执行一次 JS。
 *
 * 设计取舍：
 *  - **不引入任何 npm 依赖**，直接复用用户机器上已有的浏览器（桌面工具场景下合理）。
 *  - 找不到浏览器就静默跳过，抓取流程退回静态路径，绝不因此报错。
 *  - 可执行文件路径可用 `BROWSER_BIN` 覆盖，便于测试与自定义安装位置。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { config, ROOT } from '../config.js'

/** 常见安装位置（Windows 侧通过 /mnt/c 访问，覆盖 WSL 场景） */
const CANDIDATE_PATHS = [
  // Windows（WSL）
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

const CANDIDATE_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']

/**
 * 原生 Windows 上的候选路径。
 * 如果用户直接在 Windows 侧跑 Node（不经过 WSL），这些才是有效路径。
 */
function windowsCandidates() {
  const out = []
  const add = (base, ...rest) => {
    if (base) out.push(path.win32.join(base, ...rest))
  }
  add(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  add(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
  add(process.env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  add(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  // 用户级安装（只装给自己、没有管理员权限时走这里，很常见）
  add(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  add(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  return out
}

/**
 * WSL 下的用户级安装。
 * Chrome 也常被装在 %LOCALAPPDATA% 而不是 Program Files，
 * 上面的固定列表覆盖不到，所以扫一遍 /mnt/c/Users/*。
 */
function wslUserCandidates() {
  const out = []
  let users = []
  try {
    users = fs
      .readdirSync('/mnt/c/Users')
      .filter((u) => !/^(all users|default|default user|public|desktop\.ini)$/i.test(u))
  } catch {
    return out
  }
  for (const u of users) {
    out.push(
      path.posix.join('/mnt/c/Users', u, 'AppData/Local/Google/Chrome/Application/chrome.exe'),
      path.posix.join('/mnt/c/Users', u, 'AppData/Local/Microsoft/Edge/Application/msedge.exe'),
    )
  }
  return out
}

/** 在 PATH 中查找可执行文件（不依赖 which 命令） */
function lookInPath(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const full = path.join(dir, name)
    try {
      fs.accessSync(full, fs.constants.X_OK)
      return full
    } catch {
      /* 继续找 */
    }
  }
  return null
}

let cachedLookup
let binOverride = null

/**
 * 测试用：临时覆盖浏览器可执行文件路径（传 null 恢复为配置值）。
 * 配置对象在模块加载时就被冻结，因此无法通过改环境变量在运行期切换。
 */
export function setBrowserBinOverride(bin) {
  binOverride = bin ?? null
  cachedLookup = undefined
}

/**
 * 探测本机浏览器。
 * @returns {{available:boolean, bin:string|null, source:string, reason?:string}}
 */
export function browserStatus() {
  if (cachedLookup) return cachedLookup

  const configured = binOverride ?? config.browserBin
  if (configured) {
    try {
      fs.accessSync(configured, fs.constants.X_OK)
      cachedLookup = { available: true, bin: configured, source: binOverride ? 'override' : 'BROWSER_BIN' }
    } catch {
      cachedLookup = {
        available: false,
        bin: configured,
        source: binOverride ? 'override' : 'BROWSER_BIN',
        reason: `指定的浏览器不可执行：${configured}`,
      }
    }
    return cachedLookup
  }

  const candidates = [
    ...(process.platform === 'win32' ? windowsCandidates() : []),
    ...CANDIDATE_PATHS,
    ...(process.platform === 'linux' ? wslUserCandidates() : []),
  ]
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      cachedLookup = { available: true, bin: p, source: 'auto' }
      return cachedLookup
    } catch {
      /* 试下一个 */
    }
  }
  for (const name of CANDIDATE_NAMES) {
    const found = lookInPath(name)
    if (found) {
      cachedLookup = { available: true, bin: found, source: 'PATH' }
      return cachedLookup
    }
  }
  cachedLookup = {
    available: false,
    bin: null,
    source: 'none',
    reason: '未在本机找到 Chrome / Edge，无法渲染需要 JavaScript 的页面',
  }
  return cachedLookup
}

/** 测试用：清空探测缓存 */
export function resetBrowserCache() {
  cachedLookup = undefined
}

/**
 * 为浏览器准备一个可写的临时用户目录。
 *
 * 必须传 --user-data-dir，否则 Chrome 会尝试使用默认配置文件，
 * 在用户已开着浏览器时会失败。WSL 下 Windows 版 Chrome 需要 Windows 风格路径，
 * 因此优先放在项目目录内（必然位于 /mnt/c，能转成干净的 C:\ 路径）再用 wslpath 转换。
 */
function prepareProfileDir() {
  const base = path.join(ROOT, '.browser-profile')
  try {
    fs.mkdirSync(base, { recursive: true })
  } catch {
    const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'agreement-browser-'))
    return alt
  }
  // WSL：转成 Windows 路径给 .exe 用
  if (base.startsWith('/mnt/')) {
    try {
      const win = execFileSync('wslpath', ['-w', base], { encoding: 'utf8', timeout: 5000 }).trim()
      if (win) return win
    } catch {
      /* wslpath 不可用则原样返回 */
    }
  }
  return base
}

/** 运行浏览器并收集 stdout */
function runBrowser(bin, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }

    const chunks = []
    const MAX_BYTES = 16 * 1024 * 1024
    let bytes = 0
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出了 */
      }
      fn(value)
    }

    const timer = setTimeout(() => finish(reject, new Error(`渲染超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)
    const onAbort = () => finish(reject, new Error('已取消'))
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout.on('data', (d) => {
      bytes += d.length
      if (bytes > MAX_BYTES) {
        finish(reject, new Error('渲染结果过大'))
        return
      }
      chunks.push(d)
    })
    // Chrome 会往 stderr 写大量噪声，忽略即可
    child.stderr.on('data', () => {})
    child.on('error', (err) => finish(reject, err))
    child.on('close', () => finish(resolve, Buffer.concat(chunks).toString('utf8')))
  })
}

/** 同一页面依次尝试的参数组合：不同 Chrome 版本对 headless 参数支持不一 */
function flagVariants(profileDir) {
  const common = [
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    // 视口给高一点，让懒加载（滚动才加载）的内容尽量进入渲染范围
    '--window-size=1280,4000',
    // 等待页面 JS 执行完。给得比默认长，因为协议页常见"先骨架后填充"
    `--virtual-time-budget=${Math.max(8000, Math.min(config.browserTimeoutMs - 5000, 20000))}`,
    ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
  ]
  const withProfile = (extra) => [...extra, ...common, `--user-data-dir=${profileDir}`]
  return [
    withProfile(['--headless=new', '--dump-dom']),
    withProfile(['--headless', '--dump-dom']),
    withProfile(['--headless=old', '--dump-dom']),
  ]
}

/**
 * 渲染页面，返回执行过 JavaScript 之后的 DOM 字符串。
 *
 * @param {string} url
 * @param {{ timeoutMs?:number, signal?:AbortSignal }} [opts]
 * @returns {Promise<{ html:string, bin:string, ms:number, variant:number }>}
 * @throws {Error} 找不到浏览器、启动失败、超时，或所有参数组合都拿不到内容
 */
export async function renderPage(url, opts = {}) {
  const status = browserStatus()
  if (!status.available) throw new Error(status.reason ?? '未找到可用的浏览器')

  const timeoutMs = opts.timeoutMs ?? config.browserTimeoutMs
  const profileDir = prepareProfileDir()
  const variants = flagVariants(profileDir)
  const started = Date.now()
  const errors = []

  for (let i = 0; i < variants.length; i++) {
    if (opts.signal?.aborted) throw new Error('已取消')
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining < 3000) break
    try {
      const html = await runBrowser(status.bin, [...variants[i], url], remaining, opts.signal)
      // 只有拿到像样的 DOM 才算成功；失败时 Chrome 往往返回空
      if (html && html.length > 200 && /<html|<!doctype/i.test(html)) {
        return { html, bin: status.bin, ms: Date.now() - started, variant: i }
      }
      errors.push(`参数组合 ${i + 1} 未返回有效 DOM（${html.length} 字节）`)
    } catch (err) {
      errors.push(err.message)
    }
  }

  throw new Error(`浏览器渲染失败：${errors.join('；')}`)
}
