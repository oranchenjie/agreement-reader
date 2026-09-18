/**
 * 法律文档渲染测试。
 *
 * 这些文档会随程序分发、也可能被本地篡改，所以渲染入口按白名单清洗。
 * 这里同时验证两件事：**该挡的挡住**，以及**该留的没被误删**——
 * 后者同样重要，把免责声明清洗成空白等于没有免责声明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sanitizeLegalHtml } from '../public/js/legal.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEGAL_DIR = path.join(ROOT, 'public', 'legal')
const FILES = ['terms.html', 'disclaimer.html', 'privacy.html']

// ============================================================
// 该挡的必须挡住
// ============================================================

test('sanitize: 剥掉 script 标签及其内容', () => {
  const out = sanitizeLegalHtml('<p>前</p><script>alert(1)</script><p>后</p>')
  assert.ok(!out.includes('script'), '不应残留 script')
  assert.ok(!out.includes('alert'), '脚本内容也应一并丢弃')
  assert.ok(out.includes('前') && out.includes('后'), '正常内容要保留')
})

test('sanitize: 剥掉 style 与 iframe', () => {
  const out = sanitizeLegalHtml('<style>p{color:red}</style><iframe src="//evil"></iframe><p>正文</p>')
  assert.ok(!out.includes('style'))
  assert.ok(!out.includes('iframe'))
  assert.ok(out.includes('正文'))
})

test('sanitize: 去掉事件属性', () => {
  const out = sanitizeLegalHtml('<p onclick="steal()" onmouseover=alert(1)>文字</p>')
  assert.ok(!/on\w+/i.test(out), `不应残留事件属性：${out}`)
  assert.ok(out.includes('文字'))
})

test('sanitize: 中和 javascript: 协议', () => {
  const out = sanitizeLegalHtml('<a href="javascript:alert(1)">点我</a>')
  assert.ok(!out.includes('javascript:'), `不应残留伪协议：${out}`)
  assert.ok(out.includes('点我'))
})

test('sanitize: 不在白名单里的标签被剥掉（但保留文字）', () => {
  const out = sanitizeLegalHtml('<form><input value="x"><p>内容</p></form>')
  assert.ok(!out.includes('<form') && !out.includes('<input'), `应剥掉：${out}`)
  assert.ok(out.includes('内容'))
})

test('sanitize: 只放行 class，丢掉 style / id / data-*', () => {
  const out = sanitizeLegalHtml('<p class="legal-updated" style="color:red" id="x" data-y="1">t</p>')
  assert.ok(out.includes('class="legal-updated"'), `class 应保留：${out}`)
  assert.ok(!out.includes('style='), 'style 应丢弃')
  assert.ok(!out.includes('id='), 'id 应丢弃')
  assert.ok(!out.includes('data-y'), 'data 属性应丢弃')
})

test('sanitize: class 里的引号/尖括号被清掉，不会逃逸出属性', () => {
  const out = sanitizeLegalHtml('<p class=\'a" onload="x\'">t</p>')
  assert.ok(!out.includes('onload'), `不应被注入事件：${out}`)
})

test('sanitize: 空/非法输入安全', () => {
  assert.equal(sanitizeLegalHtml(''), '')
  assert.equal(sanitizeLegalHtml(null), '')
  assert.doesNotThrow(() => sanitizeLegalHtml(undefined))
})

// ============================================================
// 该留的不能误删 —— 清洗成空白等于没有免责声明
// ============================================================

test('sanitize: 保留标题、段落、列表、加粗', () => {
  const src = '<h2>一、标题</h2><p>段落<strong>重点</strong></p><ul><li>条目</li></ul>'
  const out = sanitizeLegalHtml(src)
  assert.ok(out.includes('<h2>'), '标题应保留')
  assert.ok(out.includes('<p>'), '段落应保留')
  assert.ok(out.includes('<strong>'), '加粗应保留')
  assert.ok(out.includes('<ul>') && out.includes('<li>'), '列表应保留')
})

for (const file of FILES) {
  test(`真实文档 ${file}: 清洗后仍有实质内容`, () => {
    const raw = fs.readFileSync(path.join(LEGAL_DIR, file), 'utf8')
    const out = sanitizeLegalHtml(raw)

    assert.ok(out.length > 500, `清洗后过短（${out.length} 字），可能被误删`)
    assert.ok((out.match(/<h2>/g) ?? []).length >= 3, '应保留多个小节标题')
    assert.ok((out.match(/<p>/g) ?? []).length >= 5, '应保留多个段落')
    assert.ok(!/<script|<style|<iframe/i.test(out), '不应残留危险标签')
    assert.ok(!/on\w+\s*=/i.test(out), '不应残留事件属性')
    assert.ok(out.includes('最后更新'), '应保留更新日期')
  })
}

test('免责声明必须明确写出「不是法律意见」与「AI 会出错」', () => {
  const raw = fs.readFileSync(path.join(LEGAL_DIR, 'disclaimer.html'), 'utf8')
  const text = sanitizeLegalHtml(raw).replace(/<[^>]+>/g, '')
  assert.ok(/不构成法律意见|不是法律意见/.test(text), '必须声明不构成法律意见')
  assert.ok(/AI|模型/.test(text) && /出错|错误|偏差/.test(text), '必须说明 AI 会出错')
})

test('用户协议必须写明 API Key 与费用责任', () => {
  const raw = fs.readFileSync(path.join(LEGAL_DIR, 'terms.html'), 'utf8')
  const text = sanitizeLegalHtml(raw).replace(/<[^>]+>/g, '')
  assert.ok(/API Key|密钥/.test(text), '必须提到 API Key 的保管责任')
  assert.ok(/费用|付费|承担/.test(text), '必须提到费用承担')
})

test('隐私说明必须写明「不收集、不上传」与密钥存放位置', () => {
  const raw = fs.readFileSync(path.join(LEGAL_DIR, 'privacy.html'), 'utf8')
  const text = sanitizeLegalHtml(raw).replace(/<[^>]+>/g, '')
  assert.ok(/不收集|不上传|不存储/.test(text), '必须说明不收集数据')
  assert.ok(/localStorage|浏览器/.test(text), '必须说明密钥存在哪里')
})
