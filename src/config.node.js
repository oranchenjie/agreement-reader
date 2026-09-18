/**
 * 服务端（Node）专属的配置加载。
 *
 * 单独成文件的原因：`node:fs` / `node:path` 这类静态 import 会让整个模块
 * **在浏览器里无法加载**（即使代码路径走不到）。把 Node 专属部分隔离出来，
 * config.js 就能做成同构的，同一份逻辑在服务端与纯静态站点里都能用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 极简 .env 解析：支持 # 注释、引号、export 前缀、\n 转义。 */
export function parseDotEnv(src) {
  const out = {}
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    let key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let val = line.slice(eq + 1).trim()
    if (!key) continue
    const quoted = /^(['"])([\s\S]*)\1$/.exec(val)
    if (quoted) {
      val = quoted[2]
      if (quoted[1] === '"') val = val.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    } else {
      val = val.replace(/\s+#.*$/, '').trim()
    }
    out[key] = val
  }
  return out
}

/** 读取 .env 与 process.env，合并成一张表（真实环境变量优先） */
export function loadNodeEnv() {
  let dotenv = {}
  const flag = process.env.DSH_IGNORE_DOTENV
  if (flag !== '1' && flag !== 'true') {
    try {
      const file = path.join(ROOT, '.env')
      if (fs.existsSync(file)) dotenv = parseDotEnv(fs.readFileSync(file, 'utf8'))
    } catch {
      /* 读不到就忽略 */
    }
  }
  return { dotenv, root: ROOT }
}
