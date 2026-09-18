/**
 * 集成测试：协议问答的反幻觉机制。
 *
 * 这是产品最核心的承诺 ——「回答不允许胡编乱造」。机制的关键在于：
 * 模型可以**声称**有依据，但无法**伪造**依据。凡是引文在原文里定位不到，
 * 一律改判为「未找到依据」，无论模型说得多肯定。
 *
 * 用一个 mock LLM 精确构造各种"想编造"的情形来验证这条防线。
 *
 * 用法：node test/integration-ask.mjs
 */
import http from 'node:http'
import path from 'node:path'

const C = {
  c1: '本公司有权随时单方面修改本协议，且无需另行通知您。您继续使用本服务即视为接受修改后的协议。',
  c2: '本公司有权随时暂停或终止您的账号，无需事先通知。账号被终止的，账户内余额不予退还。',
  c3: '您在本平台上传、发布的所有内容，您授予本公司全球范围内永久、不可撤销、免费、可转授权的许可。',
  c4: '会员服务费用一经支付不予退还。免费试用期结束后将自动续费并按月自动扣款。',
}

function makeDoc(id, title) {
  let pos = 0
  const clauses = []
  const text = Object.entries(C)
    .map(([cid, body]) => {
      const heading = `${cid} 标题`
      const full = `${heading}\n${body}`
      clauses.push({ id: cid, heading, start: pos, end: pos + full.length, index: clauses.length })
      pos += full.length + 2
      return full
    })
    .join('\n\n')
  return { id, doc: { title, text }, clauses, findings: [], report: {}, clauseNotes: [] }
}

const DOC_A = makeDoc('docA', '平台甲用户协议')
const DOC_B = makeDoc('docB', '平台乙隐私政策')

// ---------- mock LLM ----------
const calls = []
let scenario = 'valid'

function respond(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(obj) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  )
}

const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    const user = payload.messages?.find((m) => m.role === 'user')?.content ?? ''
    calls.push(user)

    // ---- 场景：检索不到内容（不该走到这里）----
    if (scenario === 'no-passage') {
      respond(res, { answerable: false, answer: '不该被调用', evidence: [], confidence: 'low' })
      return
    }

    // ---- 场景：模型编造依据（引文在原文中不存在）----
    if (scenario === 'fabricated') {
      respond(res, {
        answerable: true,
        answer: '协议规定平台必须在你注销后 30 天内彻底删除全部数据。',
        evidence: [
          { clauseId: 'c2', source: '平台甲用户协议', quote: '平台承诺在用户注销后三十日内彻底删除全部个人数据', note: '删除义务' },
        ],
        confidence: 'high',
        caveats: [],
        relatedQuestions: [],
      })
      return
    }

    // ---- 场景：clauseId 写错但引文真实（应能反查到正确条款）----
    if (scenario === 'wrong-clauseid') {
      respond(res, {
        answerable: true,
        answer: '你发布的内容会被授予永久且不可撤销的许可。',
        evidence: [{ clauseId: 'c999', source: '平台甲用户协议', quote: '全球范围内永久、不可撤销、免费、可转授权的许可', note: '授权范围' }],
        confidence: 'high',
        caveats: [],
        relatedQuestions: [],
      })
      return
    }

    // ---- 场景：部分依据真实、部分编造 ----
    if (scenario === 'mixed') {
      respond(res, {
        answerable: true,
        answer: '账号被终止后余额不退，且平台承诺不保留任何数据。',
        evidence: [
          { clauseId: 'c2', source: '平台甲用户协议', quote: '账号被终止的，账户内余额不予退还。', note: '余额不退' },
          { clauseId: 'c3', source: '平台甲用户协议', quote: '平台保证永不保留用户任何数据副本', note: '编造的' },
        ],
        confidence: 'medium',
        caveats: [],
        relatedQuestions: [],
      })
      return
    }

    // ---- 场景：明确说没有找到 ----
    if (scenario === 'notfound') {
      respond(res, {
        answerable: false,
        answer: '这些协议中没有找到相关规定。',
        evidence: [],
        confidence: 'low',
        caveats: [],
        relatedQuestions: ['协议里有没有提到数据保留期限？'],
      })
      return
    }

    // ---- 默认：正常回答 ----
    respond(res, {
      answerable: true,
      answer: '平台可以随时单方面修改协议，你继续使用就视为接受。',
      evidence: [
        { clauseId: 'c1', source: '平台甲用户协议', quote: '本公司有权随时单方面修改本协议，且无需另行通知您。', note: '单方变更权' },
      ],
      confidence: 'high',
      caveats: ['协议未说明变更前的通知方式'],
      relatedQuestions: ['如果不同意修改该怎么办？'],
    })
  })
})

const MOCK_PORT = 8898
await new Promise((r) => mock.listen(MOCK_PORT, r))

process.env.DSH_IGNORE_DOTENV = '1'
process.env.DEEPSEEK_API_KEY = 'test-key'
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`
process.env.DEEPSEEK_MODEL = 'mock'
process.env.WEB_SEARCH = '0' // 关掉联网，验证降级路径
process.env.ASK_TOP_K = '4'

const { answerQuestion } = await import('../src/analyze/ask.js')

const checks = []
const ok = (name, cond, extra = '') => checks.push({ name, pass: Boolean(cond), extra })
const auth = { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${MOCK_PORT}`, model: 'mock' }

try {
  // ============================================================
  // 1. 正常路径：依据真实 → 通过
  // ============================================================
  scenario = 'valid'
  calls.length = 0
  const r1 = await answerQuestion({ question: '平台能不能随便改协议？', documents: [DOC_A] }, auth)
  ok('正常回答被判定为可回答', r1.answerable === true)
  ok('依据通过原文核验', r1.evidence.length === 1 && r1.evidence[0].clauseId === 'c1')
  ok('引文与原文切片一致', r1.evidence[0].quote.includes('单方面修改本协议'))
  ok('保留了信心等级与提醒', r1.confidence === 'high' && r1.caveats.length > 0)

  // ============================================================
  // 2. 【核心】模型编造依据 → 必须改判
  // ============================================================
  scenario = 'fabricated'
  // 注意：这里必须用一个**能检索到条款**的问题。若问协议里根本没有的主题，
  // 会走"没检索到"的短路分支，就测不到"模型编造依据被拦下"这条关键路径了。
  const r2 = await answerQuestion({ question: '账号被终止后余额怎么处理？', documents: [DOC_A] }, auth)
  ok('【反幻觉】编造的引文被丢弃', r2.verification.dropped >= 1, `dropped=${r2.verification.dropped}`)
  ok('【反幻觉】回答被强制改判为"未找到依据"', r2.answerable === false, `answerable=${r2.answerable}`)
  ok('【反幻觉】标记了 forcedNotFound', r2.verification.forcedNotFound === true)
  ok('【反幻觉】不展示模型那段编造的回答', !r2.answer.includes('30 天内彻底删除'))
  ok('【反幻觉】给出明确的中文说明', r2.answer.includes('无法在协议原文中核验') || r2.answer.includes('没有找到'))
  ok('【反幻觉】警告中说明了原因', r2.warnings.some((w) => w.includes('未能通过原文核验')))
  ok('【反幻觉】证据链为空', r2.evidence.length === 0)

  // ============================================================
  // 3. clauseId 写错但引文真实 → 应能反查归位
  // ============================================================
  scenario = 'wrong-clauseid'
  const r3 = await answerQuestion({ question: '我的内容会被怎么使用？', documents: [DOC_A] }, auth)
  ok('clauseId 错误时用引文反查归位', r3.evidence.length === 1 && r3.evidence[0].clauseId === 'c3', `实际 ${r3.evidence[0]?.clauseId}`)
  ok('反查成功后仍判定为可回答', r3.answerable === true)

  // ============================================================
  // 4. 真假混杂 → 只保留真实的那条
  // ============================================================
  scenario = 'mixed'
  const r4 = await answerQuestion({ question: '账号被封后余额怎么办？', documents: [DOC_A] }, auth)
  ok('混杂时只保留可核验的依据', r4.evidence.length === 1 && r4.evidence[0].clauseId === 'c2', `实际 ${r4.evidence.length} 条`)
  ok('混杂时记录了丢弃数', r4.verification.dropped >= 1)
  ok('混杂时仍可回答（因为还有真实依据）', r4.answerable === true)

  // ============================================================
  // 5. 模型主动说没有找到
  // ============================================================
  scenario = 'notfound'
  const r5 = await answerQuestion({ question: '协议里有没有规定数据保留期限？', documents: [DOC_A] }, auth)
  ok('模型说没有找到时如实透传', r5.answerable === false)
  ok('保留相关的追问建议', r5.relatedQuestions.length > 0)

  // ============================================================
  // 6. 字面检索一无所获 → 改为「整篇送检」，让模型判断
  //
  // 这里刻意不再"检索不到就不调用模型"。实测教训：用户问「付了钱能退吗」，
  // 而协议写的是「不予退还」——字面毫无重叠，抢先回答"协议里没写"是在冤枉协议。
  // 正确做法是把判断权交给模型（它还看得到原文），而不是由字面匹配替它下结论。
  // ============================================================
  scenario = 'no-passage'

  // 6a. 默认（auto）应把全文交给模型，而不是先做筛选
  calls.length = 0
  const r6 = await answerQuestion({ question: '请问公司年会在哪里举办', documents: [DOC_A] }, auth)
  ok('默认策略是送全文而非先筛选', r6.retrieval?.mode === 'full-context', JSON.stringify(r6.retrieval))
  ok('送全文时确实调用了模型', calls.length > 0, `调用 ${calls.length} 次`)
  ok('模型说没有时如实透传', r6.answerable === false)
  ok('送全文时不产生「已筛选」的提示', !r6.warnings.some((w) => w.includes('只送检了')))

  // 6b. 全文里确实没有 → 模型仍应如实说没有（而不是编一个）
  calls.length = 0
  const r6c = await answerQuestion({ question: '今天天气怎么样', documents: [DOC_A] }, auth)
  ok('全文送检后仍可如实回答未找到', r6c.answerable === false)
  ok('无关问题也没有编造依据', r6c.evidence.length === 0)

  // ============================================================
  // 6b. 【实测回归】口语化提问必须能命中协议用语
  // ============================================================
  scenario = 'valid'
  calls.length = 0
  const r6b = await answerQuestion({ question: '付了钱能退吗？', documents: [DOC_A] }, auth)
  ok('口语化提问不再被判为"没找到"', r6b.answerable === true, `answerable=${r6b.answerable}`)
  ok('口语化提问走到了模型（生成式回答）', calls.length > 0, `调用 ${calls.length} 次`)
  ok('口语化提问走的是全文送检（默认策略）', r6b.retrieval?.mode === 'full-context', JSON.stringify(r6b.retrieval))

  // ============================================================
  // 6c. 语料超出预算时才退回检索（用子进程，因为配置在模块加载时冻结）
  // ============================================================
  {
    // 必须用异步版：execFileSync 会阻塞父进程事件循环，
    // 而 mock 模型服务就跑在父进程里 —— 会直接死锁成超时。
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const probe = `
      process.env.DSH_IGNORE_DOTENV='1'
      process.env.DEEPSEEK_API_KEY='k'
      process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:${MOCK_PORT}'
      process.env.DEEPSEEK_MODEL='mock'
      process.env.WEB_SEARCH='0'
      process.env.ASK_WHOLE_DOC_CHARS='30'   // 故意小于语料，逼出检索路径
      const { answerQuestion } = await import('./src/analyze/ask.js')
      const doc = { id:'x', doc:{ title:'T', text:'第一条 费用\\n已支付的费用不予退还。\\n第二条 数据\\n我们可能与关联方共享你的信息。' },
        clauses:[{id:'c1',heading:'第一条 费用',start:0,end:20,index:0},{id:'c2',heading:'第二条 数据',start:21,end:50,index:1}] }
      const r = await answerQuestion({ question:'付了钱能退吗', documents:[doc] }, {})
      console.log(JSON.stringify({ mode: r.retrieval?.mode, whole: r.wholeDocument, warned: (r.warnings||[]).some(w=>w.includes('只送检了')) }))
    `
    let out = null
    try {
      const { stdout } = await run(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
      })
      out = JSON.parse(stdout.trim())
    } catch (err) {
      const detail = String(err.stderr || err.message || '')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('    at'))
        .slice(0, 2)
        .join(' | ')
      ok('超预算时退回检索', false, detail.slice(0, 120))
    }
    if (out) {
      ok('语料超预算且检索命中时，只送相关条款', out.whole === false, JSON.stringify(out))
      ok('退回检索时明确告知用户被筛选', out.warned === true)
    }

    // 【关键】语料超预算 + 检索一无所获 → 绝不能空手拒答，
    // 必须把能装下的部分交给模型（用户看到"没找到"会以为协议真没写）
    const probe2 = `
      process.env.DSH_IGNORE_DOTENV='1'
      process.env.DEEPSEEK_API_KEY='k'
      process.env.DEEPSEEK_BASE_URL='http://127.0.0.1:${MOCK_PORT}'
      process.env.DEEPSEEK_MODEL='mock'
      process.env.WEB_SEARCH='0'
      process.env.ASK_WHOLE_DOC_CHARS='30'    // 故意小于语料
      const { answerQuestion } = await import('./src/analyze/ask.js')
      const doc = { id:'x', doc:{ title:'T', text:'第一条 费用\\n已支付的费用不予退还。\\n第二条 数据\\n我们可能与关联方共享你的信息。' },
        clauses:[{id:'c1',heading:'第一条 费用',start:0,end:19,index:0},{id:'c2',heading:'第二条 数据',start:20,end:50,index:1}] }
      // 问一个连宽泛匹配都命中不了的问题
      const r = await answerQuestion({ question:'今天天气怎么样', documents:[doc] }, {})
      console.log(JSON.stringify({ mode:r.retrieval?.mode, whole:r.wholeDocument, clauses:r.retrieval?.clauses, answerLen:(r.answer||'').length }))
    `
    let out2 = null
    try {
      const { stdout } = await run(process.execPath, ['--input-type=module', '-e', probe2], {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
      })
      out2 = JSON.parse(stdout.trim())
    } catch (err) {
      const detail = String(err.stderr || err.message || '')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('    at'))
        .slice(0, 2)
        .join(' | ')
      ok('超预算且检索无果时仍送检', false, detail.slice(0, 120))
    }
    if (out2) {
      ok('【关键】超预算且检索无果时，仍把能装下的部分交给模型', out2.whole === true, JSON.stringify(out2))
      ok('该情形被标记为 full-context-partial', out2.mode === 'full-context-partial', out2.mode)
      ok('确实送检了内容（不是空手）', (out2.clauses ?? 0) > 0, `${out2.clauses} 个条款`)
      ok('给出了回答（而不是空响应）', out2.answerLen > 0, `${out2.answerLen} 字`)
    }
  }

  // ============================================================
  // 7. 多份协议作为知识库
  // ============================================================
  scenario = 'valid'
  const r7 = await answerQuestion({ question: '平台能不能单方面改协议？', documents: [DOC_A, DOC_B] }, auth)
  ok('多份协议都纳入语料', r7.documents.length === 2, `${r7.documents.length} 份`)
  ok('每条依据都标注来源文档', r7.evidence.every((e) => e.docId && e.docTitle))
  const seenTitles = r7.documents.map((d) => d.title)
  ok('语料标题正确', seenTitles.includes('平台甲用户协议') && seenTitles.includes('平台乙隐私政策'))

  // ============================================================
  // 8. 联网搜索关闭时优雅降级
  // ============================================================
  scenario = 'valid'
  const r8 = await answerQuestion({ question: '平台能不能随便改协议？', documents: [DOC_A], useWeb: true }, auth)
  ok('要求联网但被关闭时给出提示', r8.web.used === false && r8.web.warnings.length > 0, r8.web.warnings[0]?.slice(0, 30))
  ok('联网不可用不影响协议问答', r8.answerable === true && r8.evidence.length > 0)

  // ============================================================
  // 9. 边界与错误处理
  // ============================================================
  let emptyQ = null
  try {
    await answerQuestion({ question: '   ', documents: [DOC_A] }, auth)
  } catch (e) {
    emptyQ = e
  }
  ok('空问题被拒绝且有中文提示', emptyQ?.code === 'EMPTY_QUESTION', emptyQ?.message)

  let noDoc = null
  try {
    await answerQuestion({ question: '有效问题', documents: [] }, auth)
  } catch (e) {
    noDoc = e
  }
  ok('没有语料时给出明确错误', noDoc?.code === 'NO_DOCUMENTS', noDoc?.message)

  // 请求未带 key 但服务端环境变量有 key 时，应回退到服务端配置（而不是直接报错）
  scenario = 'valid'
  const r9 = await answerQuestion({ question: '平台能不能随便改协议？', documents: [DOC_A] }, {
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
  })
  ok('未带 key 时回退到服务端配置', r9.answerable === true && r9.evidence.length > 0)

  // 明确要求一个不可达的地址时，应给出可读错误而不是静默失败
  let badEndpoint = null
  try {
    await answerQuestion({ question: '平台能不能随便改协议？', documents: [DOC_A] }, {
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:1',
      model: 'm',
    })
  } catch (e) {
    badEndpoint = e
  }
  ok('模型不可达时报出可读错误', Boolean(badEndpoint) && /失败|超时|请求/.test(badEndpoint.message), badEndpoint?.message?.slice(0, 40))
} finally {
  mock.close()
}

console.log('--- checks ---')
let failed = 0
for (const c of checks) {
  if (!c.pass) failed++
  console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.extra ? `  (${c.extra})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
