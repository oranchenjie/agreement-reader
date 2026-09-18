/**
 * Windows 批处理脚本的静态校验。
 *
 * 存在的理由：`.cmd` 是**没法在 WSL 里执行验证**的，而它一旦有问题，
 * 用户双击后只会"闪一下"或者毫无反应，几乎拿不到任何线索。
 * 这里用静态检查把几类已知的致命问题挡在提交之前：
 *
 *   1. **LF 行尾** —— 纯 LF 的 .cmd 在 cmd.exe 里会解析失败（真实踩过）
 *   2. **命令行里出现非 ASCII** —— 中文要过 Windows ANSI 代码页，
 *      放在 start 的窗口标题、路径参数里很容易崩；中文只允许出现在 echo/set/rem 里
 *   3. **括号不配对** —— 批处理块结构的常见崩点
 *   4. 关键步骤缺失 —— 比如忘了按端口结束旧进程
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = ['启动.cmd', '停止.cmd', '诊断.cmd']

const GBK = new TextDecoder('gbk')

function readScript(name) {
  const buf = fs.readFileSync(path.join(ROOT, name))
  // Node 的 Buffer.toString 不支持 gbk，必须走 TextDecoder
  return { buf, latin1: buf.toString('latin1'), gbk: GBK.decode(buf) }
}

/** 只保留「真正的命令行」：去掉 echo / set / rem / 标签 / 注释 */
function commandLines(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim().toLowerCase()
      if (!t) return false
      if (t.startsWith('echo') || t.startsWith('set ') || t.startsWith('rem') || t.startsWith('::')) return false
      return true
    })
}

for (const name of SCRIPTS) {
  test(`${name}: 必须存在且非空`, () => {
    const { buf } = readScript(name)
    assert.ok(buf.length > 100, '文件过小，可能没写成功')
  })

  test(`${name}: 【关键】行尾必须是 CRLF，不能有裸 LF`, () => {
    const { latin1 } = readScript(name)
    const bareLf = (latin1.match(/(?<!\r)\n/g) ?? []).length
    assert.equal(bareLf, 0, `发现 ${bareLf} 处裸 LF —— cmd.exe 会解析失败`)
  })

  test(`${name}: 命令行里不能出现非 ASCII 字符`, () => {
    const { gbk } = readScript(name)
    const bad = commandLines(gbk).filter((l) => /[^\x00-\x7F]/.test(l))
    // 允许 "if ... echo 中文" 这种把中文当输出文本的写法
    const reallyBad = bad.filter((l) => !/\becho\b/i.test(l))
    assert.deepEqual(reallyBad, [], `命令行含非 ASCII：\n${reallyBad.join('\n')}`)
  })

  test(`${name}: 括号必须配对`, () => {
    const { gbk } = readScript(name)
    let depth = 0
    for (const line of gbk.split('\r\n')) {
      let inQuote = false
      for (const ch of line) {
        if (ch === '"') inQuote = !inQuote
        else if (!inQuote && ch === '(') depth++
        else if (!inQuote && ch === ')') depth--
      }
    }
    assert.equal(depth, 0, `括号不配对（净差 ${depth}）`)
  })
}

test('启动.cmd: 已合并「停止 + 启动」，且含关键步骤', () => {
  const { gbk } = readScript('启动.cmd')
  assert.match(gbk, /netstat -ano/, '必须按端口找旧进程')
  assert.match(gbk, /taskkill \/PID/, '必须结束旧进程')
  assert.match(gbk, /start .*server\.js/, '必须启动服务')
  // 脚本里 URL 是拼出来的（http://127.0.0.1:%PORT%），所以只断言主机部分
  assert.match(gbk, /http:\/\/127\.0\.0\.1:%PORT%/, '必须打开浏览器')
  assert.match(gbk, /set "PORT=8787"/, '必须定义端口')
  assert.match(gbk, /set \/p .*CONFIRM/i, '必须有确认步骤')
})

test('启动.cmd: 覆盖多种 Node 安装位置', () => {
  const { gbk } = readScript('启动.cmd')
  assert.match(gbk, /nodejs/, '应查找 nodejs 安装目录')
  assert.match(gbk, /%~\$PATH:i/, '应在 PATH 中兜底查找')
})

test('启动.cmd: 找不到 Node 时给出可操作的提示而不是静默退出', () => {
  const { gbk } = readScript('启动.cmd')
  assert.match(gbk, /找不到 Node/, '应提示找不到 Node')
  assert.match(gbk, /nodejs\.org/, '应给出下载地址')
  assert.match(gbk, /pause/, '应暂停让用户看到信息')
})

test('停止.cmd: 按端口结束进程，且 WSL 侧也停一次', () => {
  const { gbk } = readScript('停止.cmd')
  assert.match(gbk, /netstat -ano/)
  assert.match(gbk, /taskkill \/PID/)
  assert.match(gbk, /wsl\.exe/, '应顺带停掉 WSL 侧的服务')
})

test('诊断.cmd: 全 ASCII 输出（避免编码干扰排查）', () => {
  const { gbk } = readScript('诊断.cmd')
  // 诊断脚本刻意全用英文，避免任何编码因素干扰阅读
  const nonAscii = gbk.split(/\r?\n/).filter((l) => /[^\x00-\x7F]/.test(l))
  assert.deepEqual(nonAscii, [], `诊断脚本不应含非 ASCII：\n${nonAscii.slice(0, 3).join('\n')}`)
})

test('三个脚本都能被 GBK 解码（中文不会变成乱码字节）', () => {
  for (const name of SCRIPTS) {
    const { buf } = readScript(name)
    const decoded = GBK.decode(buf)
    assert.ok(!decoded.includes('\uFFFD'), `${name} 含无法用 GBK 解码的字节`)
  }
})
