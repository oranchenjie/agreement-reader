/**
 * 配置（同构）。
 *
 * 同一份文件同时用于两种情况：
 *   - 服务端：从 `.env` 与环境变量读取
 *   - 纯静态站点（GitHub Pages）：没有 .env，全部走默认值，
 *     密钥/模型等由用户在界面上填、按请求传入（见 resolveRuntime）
 *
 * Node 专属的读写逻辑被隔离在 config.node.js 里，通过**动态 import** 按需加载 ——
 * 静态 import 'node:fs' 会让这个模块在浏览器里直接加载失败。
 */
const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node)

/** 浏览器端没有 .env，这张表就是空的 */
let dotenv = {}
export let ROOT = ''

if (isNode) {
  const node = await import('./config.node.js')
  const loaded = node.loadNodeEnv()
  dotenv = loaded.dotenv
  ROOT = loaded.root
}


function env(key, fallback = '') {
  // 浏览器里没有 process —— 必须守卫，否则整个模块加载即抛错
  const v = isNode ? process.env[key] : undefined
  if (v !== undefined && v !== '') return v
  const d = dotenv[key]
  if (d !== undefined && d !== '') return d
  return fallback
}

function intEnv(key, fallback) {
  const n = Number.parseInt(env(key, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function boolEnv(key, fallback = false) {
  const v = env(key, '').toLowerCase()
  if (!v) return fallback
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export const config = Object.freeze({
  port: intEnv('PORT', 8787),

  apiKey: env('DEEPSEEK_API_KEY', ''),
  baseUrl: env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: env('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
  modelSummary: env('DEEPSEEK_MODEL_SUMMARY', env('DEEPSEEK_MODEL', 'deepseek-v4-flash')),

  mock: boolEnv('DSH_AGREEMENT_MOCK', false),

  /**
   * 单次调用的输出上限。
   * 注意：推理模型（reasoner / pro 类）的 max_tokens 通常**同时覆盖思考过程与正文**。
   * 额度不够时会先耗尽在思考上，导致 content 为空且 finish_reason=length —— 
   * 因此这里的默认值给得比"只算正文"所需宽松得多。
   */
  maxTokensMap: intEnv('DEEPSEEK_MAX_TOKENS', 8192),

  /**
   * 是否让模型"思考"。
   *   auto（默认）：不传该参数，用服务端默认行为
   *   disabled    ：关闭思考，把全部额度留给正文
   *   enabled     ：强制开启
   * 逐条分析这类**结构化抽取**任务并不需要深度推理，开着思考只会白烧额度。
   */
  thinking: env('DEEPSEEK_THINKING', 'auto').toLowerCase(),
  /** 思考强度（API 的 reasoning_effort），留空则不传 */
  reasoningEffort: env('DEEPSEEK_REASONING_EFFORT', ''),
  maxTokensSummary: intEnv('DEEPSEEK_MAX_TOKENS_SUMMARY', 16384),
  maxTokensAsk: intEnv('DEEPSEEK_MAX_TOKENS_ASK', 8192),

  /**
   * 问答的上下文策略。
   *   auto（默认）：语料放得下就**整篇送**，放不下才退回检索
   *   full        ：总是整篇送（放不下会明确报错，提示减少协议）
   *   retrieve    ：总是先做检索筛选
   *
   * 默认整篇送的理由：模型上下文足够大，而检索的字面匹配会**替模型下结论** ——
   * 用户问「付了钱能退吗」而协议写「不予退还」，检索会一无所获，
   * 于是系统错误地回答"协议里没写"。判断权应该归模型，不该归检索。
   */
  askContextMode: env('ASK_CONTEXT_MODE', 'auto').toLowerCase(),

  /** 协议问答：检索多少段、喂多少字 */
  askTopK: intEnv('ASK_TOP_K', 8),
  askMaxChars: intEnv('ASK_MAX_CHARS', 20000),
  /**
   * 检索一无所获时，「整篇送检」的字符上限。
   * 给得比常规检索宽松得多 —— 宁可多花点 token，也不要因为用词不同
   * 就告诉用户"协议里没写"。
   */
  /**
   * 整篇送检的字符上限。
   * 给得很大是刻意的：这些模型上下文是 100 万 token，一份协议通常才几万字。
   * 限额设小了会退回检索，而检索的字面匹配会替模型下结论 —— 那是更糟的结果。
   */
  askWholeDocChars: intEnv('ASK_WHOLE_DOC_CHARS', 500000),
  askMaxDocs: intEnv('ASK_MAX_DOCS', 8),

  /** 联网搜索：是否允许（用户仍需在界面上主动开启），以及取几条结果 */
  webSearchEnabled: boolEnv('WEB_SEARCH', true),
  webSearchMaxResults: intEnv('WEB_SEARCH_MAX_RESULTS', 5),
  webSearchTimeoutMs: intEnv('WEB_SEARCH_TIMEOUT_MS', 12_000),
  /** 遇到"额度耗尽但没正文"时允许自动加倍到这个上限 */
  maxTokensCeiling: intEnv('DEEPSEEK_MAX_TOKENS_CEILING', 65536),

  concurrency: Math.min(intEnv('ANALYZE_CONCURRENCY', 3), 8),
  chunkChars: intEnv('ANALYZE_CHUNK_CHARS', 6000),
  timeoutMs: intEnv('DEEPSEEK_TIMEOUT_MS', 180_000),
  maxTextChars: intEnv('ANALYZE_MAX_TEXT_CHARS', 400_000),

  /** URL 抓取上限（字节）与超时 */
  maxFetchBytes: intEnv('MAX_FETCH_BYTES', 8 * 1024 * 1024),
  fetchTimeoutMs: intEnv('FETCH_TIMEOUT_MS', 30_000),
  /** 是否允许抓取内网/本机地址。默认禁止（防 SSRF）；本地联调可设 1。 */
  allowPrivateUrls: boolEnv('ALLOW_PRIVATE_URLS', false),

  /**
   * 对 JavaScript 渲染的页面（SPA），使用本机已安装的 Chrome/Edge 做无头渲染。
   * 抓取静态 HTML 拿不到正文时才会触发；找不到浏览器会自动跳过。
   */
  browserRender: boolEnv('BROWSER_RENDER', true),
  /** 手动指定浏览器可执行文件（留空则自动探测） */
  browserBin: env('BROWSER_BIN', ''),
  browserTimeoutMs: intEnv('BROWSER_TIMEOUT_MS', 30_000),
  /** 渲染后仍少于这么多字符，就认为抓取失败并明确告知用户 */
  minUsefulChars: intEnv('MIN_USEFUL_CHARS', 300),

  /** 未配置 Key 且未开 mock 时，服务端仍然启动，但分析接口会返回明确的引导错误。 */
  get canCallApi() {
    return this.mock || Boolean(this.apiKey)
  },
})

export function describeConfig() {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    modelSummary: config.modelSummary,
    mock: config.mock,
    hasApiKey: Boolean(config.apiKey),
    concurrency: config.concurrency,
    chunkChars: config.chunkChars,
  }
}

/** 供前端下拉参考的常见模型名（仍允许自由输入） */
export const KNOWN_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
]

/**
 * 把「请求携带的覆盖项」与环境配置合并成一次分析实际使用的运行时参数。
 *
 * 优先级：请求携带 > 服务端环境变量。
 * 这样用户可以在网页里自己填 Key，不必改服务端配置；服务端也无需保存任何密钥。
 *
 * @param {{ apiKey?:string, baseUrl?:string, model?:string, modelSummary?:string }} [overrides]
 */
export function resolveRuntime(overrides = {}) {
  const reqKey = (overrides.apiKey ?? '').trim()
  const reqModel = (overrides.model ?? '').trim()

  const apiKey = reqKey || config.apiKey
  const baseUrl = ((overrides.baseUrl ?? '').trim() || config.baseUrl).replace(/\/+$/, '')
  const model = reqModel || config.model
  // 只覆盖了分析模型时，汇总模型跟随，避免它悄悄用回环境里的另一个模型
  const modelSummary = (overrides.modelSummary ?? '').trim() || (reqModel ? reqModel : config.modelSummary)

  return {
    apiKey,
    baseUrl,
    model,
    modelSummary,
    hasKey: Boolean(apiKey),
    keySource: reqKey ? 'request' : config.apiKey ? 'server' : 'none',
  }
}

/**
 * 兜底脱敏：任何要返回给前端或写进日志的文本，都过一遍这里。
 * 正常情况下密钥根本不会出现在错误信息里，但这类防护必须是"万一"而不是"应该"。
 */
export function redactSecrets(input) {
  return String(input ?? '').replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-***')
}
