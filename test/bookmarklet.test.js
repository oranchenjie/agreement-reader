/**
 * 书签生成器测试。
 *
 * 存在的意义：书签脚本是「以字符串形式嵌进 URL 的 JS」，一旦有转义错误，
 * 用户点下去只会**静默失败**——连 alert 都不会弹，几乎没有排查线索。
 * 这个 bug 真实发生过一次（模板字符串把 `\n` 提前吃掉了），所以必须有测试守着。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildBookmarklet, bookmarkletSource, resolveTargets } from '../public/js/bookmarklet.js'

const ORIGIN = 'http://127.0.0.1:8787'

test('生成的地址以 javascript: 开头', () => {
  const href = buildBookmarklet(ORIGIN)
  assert.ok(href.startsWith('javascript:'), '书签必须是 javascript: 协议')
})

test('【关键】解码后的脚本必须是合法 JavaScript', () => {
  const src = bookmarkletSource(ORIGIN)
  // 语法错误会让书签在浏览器里静默失效
  assert.doesNotThrow(() => new Function(src), `书签脚本存在语法错误：\n${src}`)
})

test('【回归】正则与字符串里的 \\n 不会被模板字符串提前吃掉', () => {
  const src = bookmarkletSource(ORIGIN)
  // 曾经写成了真实的换行符，导致 /<换行>{3,}/ 这样的非法正则
  assert.ok(src.includes('/\\n{3,}/g'), '压缩空行的正则必须保留为转义形式')
  assert.ok(!/replace\(\/\n/.test(src), '不应出现被展开成真实换行的正则')
  // 脚本里不能出现裸换行导致的断裂（除缩进用的换行外，正则在同一行内）
  const regexLine = src.split('\n').find((l) => l.includes('replace('))
  assert.ok(regexLine && regexLine.includes('/\\n{3,}/g'), '正则必须完整地位于一行内')
})

test('注入了调用方的 origin，且不带结尾斜杠', () => {
  const src = bookmarkletSource('http://127.0.0.1:8787/')
  assert.ok(src.includes('http://127.0.0.1:8787'), '应包含当前来源地址')
})

test('自定义端口 / 主机名同样生效', () => {
  const src = bookmarkletSource('http://172.23.74.207:9999')
  assert.ok(src.includes('http://172.23.74.207:9999'))
})

// ============================================================
// 多地址投递 —— 这是"书签点了没反应"的根治办法
// ============================================================

test('resolveTargets: 同时给出当前来源与同端口的 127.0.0.1', () => {
  const t = resolveTargets('http://172.23.74.207:8787')
  assert.ok(t.includes('http://172.23.74.207:8787'), '应含当前来源')
  assert.ok(t.includes('http://127.0.0.1:8787'), '应含同端口的回环地址')
})

test('resolveTargets: 从 127.0.0.1 打开时不重复添加', () => {
  const t = resolveTargets('http://127.0.0.1:8787')
  assert.equal(t.filter((x) => x === 'http://127.0.0.1:8787').length, 1)
})

test('resolveTargets: 额外地址会被并入并去重', () => {
  const t = resolveTargets('http://127.0.0.1:8787', ['http://172.23.74.207:8787', 'http://127.0.0.1:8787', 'bad-url'])
  assert.ok(t.includes('http://172.23.74.207:8787'))
  assert.equal(new Set(t).size, t.length, '结果不应有重复')
  assert.ok(!t.includes('bad-url'), '非法地址应被忽略')
})

test('resolveTargets: https 来源时按 443 推导回环地址', () => {
  const t = resolveTargets('https://example.com')
  assert.ok(t.includes('http://127.0.0.1:443'), `实际：${t.join(',')}`)
})

test('resolveTargets: 非法输入不抛异常，且有兜底地址', () => {
  assert.doesNotThrow(() => resolveTargets(''))
  assert.doesNotThrow(() => resolveTargets(null))
  // 兜底很重要：地址列表为空会让书签变成"点了什么都不做"，最难排查
  assert.ok(resolveTargets(null).length > 0, '不应返回空列表')
  assert.equal(resolveTargets(null)[0], 'http://127.0.0.1:8787')
})

test('【关键】脚本会向所有候选地址投递，而不是只发一个', () => {
  const src = bookmarkletSource('http://172.23.74.207:8787', ['http://127.0.0.1:8787'])
  assert.ok(src.includes('var targets='), '应把候选地址列表写进脚本')
  assert.ok(src.includes('targets.map('), '应对每个地址发起请求')
  assert.ok(src.includes('Promise.allSettled'), '应等待全部投递结果后再提示')
  assert.ok(src.includes('http://172.23.74.207:8787') && src.includes('http://127.0.0.1:8787'))
})

test('【关键】全失败时给出可执行的替代方案与候选地址', () => {
  const src = bookmarkletSource('http://172.23.74.207:8787')
  assert.ok(src.includes('所有候选地址都不可达'), '应说明失败原因')
  assert.ok(src.includes('targets.join'), '应把候选地址列给用户看')
  assert.ok(src.includes('Ctrl+A'), '应给出复制粘贴的替代方案')
})

test('多地址脚本依然是合法 JavaScript', () => {
  const src = bookmarkletSource('http://172.23.74.207:8787', ['http://127.0.0.1:8787', 'http://localhost:8787'])
  assert.doesNotThrow(() => new Function(src), `语法错误：\n${src}`)
})

test('使用渲染后文本而非 HTML（这是它能绕过 SPA 的原因）', () => {
  const src = bookmarkletSource(ORIGIN)
  assert.ok(src.includes('innerText'), '必须用 innerText 取渲染后的可见文本')
  assert.ok(!src.includes('outerHTML'), '不应依赖原始 HTML')
})

test('使用 no-cors + text/plain 以避免 CORS 预检', () => {
  const src = bookmarkletSource(ORIGIN)
  assert.ok(src.includes("mode:'no-cors'"), 'no-cors 可避免预检失败')
  assert.ok(src.includes("'Content-Type':'text/plain'"), 'text/plain 属于 CORS 安全列表内的类型')
})

test('有长度保护，不会把超大页面整个发出去', () => {
  const src = bookmarkletSource(ORIGIN)
  assert.ok(src.includes('300000'), '应有长度上限')
  assert.ok(src.includes('length<50'), '内容太短时应提示而不是发送空内容')
})

test('失败时会给出可执行的替代方案（复制粘贴）', () => {
  const src = bookmarkletSource(ORIGIN)
  assert.ok(src.includes('Ctrl+A') && src.includes('Ctrl+C'), '失败提示应引导用户手动复制')
})

test('编码是幂等的：重复编解码不改变脚本', () => {
  const a = bookmarkletSource(ORIGIN)
  const b = decodeURIComponent(buildBookmarklet(ORIGIN).replace(/^javascript:/, ''))
  assert.equal(a, b)
})
