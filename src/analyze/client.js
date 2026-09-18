/**
 * DeepSeek API 客户端（OpenAI 兼容 /chat/completions）。
 * 零依赖：使用 Node 内置 fetch。
 *
 * 关注点：超时、限流退避、可取消、用量统计、JSON 输出模式。
 */
import { config, resolveRuntime, redactSecrets } from '../config.js'
import { parseModelJson } from './json.js'

export class ApiError extends Error {
  constructor(message, { status = 0, retryable = false, body = '' } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryable = retryable
    this.body = body
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    }
  })
}

function combineSignals(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return external ? AbortSignal.any([timeout, external]) : timeout
}

/**
 * 调用模型并解析为 JSON 对象。
 *
 * @param {object} params
 * @param {Array<{role:string,content:string}>} params.messages
 * @param {{apiKey:string,baseUrl:string,model:string}} [params.auth] 本次调用使用的凭据（来自请求或环境）
 * @param {string} [params.model] 覆盖 auth.model
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {AbortSignal} [params.signal]
 * @param {string} [params.salvageKey] 截断恢复时尝试恢复的字段名
 * @param {string} [params.label] 日志标签
 * @returns {Promise<{ data:any, usage:{prompt_tokens:number,completion_tokens:number,total_tokens:number}, model:string, warnings:string[], ms:number }>}
 */
export async function chatJSON({
  messages,
  model,
  temperature = 0.1,
  maxTokens = 8192,
  signal,
  salvageKey,
  label = 'chat',
  auth,
} = {}) {
  const rt = auth ?? resolveRuntime()
  const modelId = model || rt.model

  if (!rt.apiKey && !config.mock) {
    throw new ApiError('未配置 DeepSeek API Key。请在页面右上角「模型设置」中填入，或在服务端 .env 中配置 DEEPSEEK_API_KEY。', {
      status: 401,
    })
  }

  const url = `${rt.baseUrl}/chat/completions`
  const warnings = []
  const maxAttempts = 4
  let lastErr

  // 输出额度可变：命中"额度耗尽却无正文"时自动加倍重试
  let maxTokensEffort = Math.max(256, Number(maxTokens) || config.maxTokensMap)
  // 推理模型的思考会吃掉整个额度：命中该症状时直接关掉思考，
  // 这比一味加倍 max_tokens 有效得多（思考量会随额度一起增长）。
  let thinkingOverride = null
  let thinkingRejected = false

  const buildBody = () => {
    const body = {
      model: modelId,
      messages,
      temperature,
      max_tokens: maxTokensEffort,
      response_format: { type: 'json_object' },
      stream: false,
    }
    const thinking = thinkingOverride ?? (config.thinking === 'auto' ? null : config.thinking)
    if (thinking === 'disabled' || thinking === 'enabled') {
      body.thinking = { type: thinking }
    }
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort
    return body
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now()
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rt.apiKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(buildBody()),
        signal: combineSignals(config.timeoutMs, signal),
      })
    } catch (err) {
      lastErr = new ApiError(redactSecrets(`网络请求失败：${err?.message || err}`), { retryable: true })
      if (signal?.aborted) throw new ApiError('分析已取消', { status: 499 })
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt), signal).catch(() => {})
        continue
      }
      throw lastErr
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')

      // 有些 OpenAI 兼容网关不认识 thinking 参数，会直接 400。
      // 这时把它去掉、改走"提高额度"的老路，而不是让整次分析失败。
      if (res.status === 400 && thinkingOverride === 'disabled' && /think|reasoning|unknown|unsupported|extra/i.test(body)) {
        // 记下来，之后不再尝试 —— 否则会在"关思考→被拒→加倍额度→又关思考"之间来回拉锯
        thinkingRejected = true
        thinkingOverride = null
        warnings.push('该接口不支持关闭思考的参数，已改为提高输出上限后重试。')
        if (attempt < maxAttempts) continue
      }

      const retryable = RETRYABLE_STATUS.has(res.status)
      lastErr = new ApiError(explainStatus(res.status, body), { status: res.status, retryable, body: body.slice(0, 800) })
      if (retryable && attempt < maxAttempts) {
        const retryAfter = Number.parseFloat(res.headers.get('retry-after') || '')
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs(attempt), signal).catch(() => {})
        continue
      }
      throw lastErr
    }

    const payload = await res.json().catch(async () => {
      throw new ApiError('模型返回体不是合法 JSON', { status: 502, retryable: true })
    })

    const choice = payload?.choices?.[0]
    const content = choice?.message?.content ?? ''
    // 推理模型会把思考过程放在这个字段里（DeepSeek reasoner 系列、部分 pro 模型）
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? ''
    const finish = choice?.finish_reason
    const usage = {
      prompt_tokens: payload?.usage?.prompt_tokens ?? 0,
      completion_tokens: payload?.usage?.completion_tokens ?? 0,
      total_tokens: payload?.usage?.total_tokens ?? 0,
    }

    if (!content) {
      // 关键场景：推理模型把 max_tokens 全部消耗在思考过程上，
      // 于是 content 为空、finish_reason=length。
      //
      // 恢复策略有优先级：
      //   1) 先关掉思考 —— 思考量会随额度一起膨胀，单纯加倍额度往往治不好；
      //   2) 关不了（网关不支持该参数）再退回到加倍额度。
      const ceiling = Math.max(config.maxTokensCeiling, maxTokensEffort)
      const reasoningNote = reasoning ? `，思考过程已占用 ${reasoning.length} 字` : ''

      if (!thinkingRejected && thinkingOverride !== 'disabled' && reasoning && attempt < maxAttempts) {
        thinkingOverride = 'disabled'
        warnings.push(
          `模型 ${modelId} 未产出正文（finish_reason=${finish || 'unknown'}${reasoningNote}），` +
            `已改用「关闭思考」重试（只对本次生效）。`,
        )
        continue
      }

      if (maxTokensEffort < ceiling && attempt < maxAttempts) {
        const next = Math.min(maxTokensEffort * 2, ceiling)
        warnings.push(
          `模型 ${modelId} 未产出正文（finish_reason=${finish || 'unknown'}${reasoningNote}），` +
            `已将输出上限从 ${maxTokensEffort} 提高到 ${next} 后重试。`,
        )
        maxTokensEffort = next
        continue
      }

      const reason = finish || 'unknown'
      lastErr = new ApiError(
        reason === 'length'
          ? `模型 ${modelId} 的输出额度被"思考"耗尽（finish_reason=length，思考过程 ${reasoning.length} 字）却仍未产出正文。` +
            `关闭思考与加倍额度都没能解决。建议在「模型设置」里把「逐条分析模型」换成非推理模型（如 deepseek-v4-flash）——` +
            `逐条抽取并不需要深度推理，开着思考只会白烧额度。`
          : `模型 ${modelId} 返回空内容（finish_reason=${reason}）`,
        { status: 502, retryable: true },
      )
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt), signal).catch(() => {})
        continue
      }
      throw lastErr
    }

    try {
      const data = parseModelJson(content, { salvageKey, warnings })
      if (finish === 'length') {
        warnings.push(
          `模型输出达到长度上限，结果可能不完整（可提高 max_tokens 或减小分片大小）${
            reasoning ? `；本次思考过程占用 ${reasoning.length} 字` : ''
          }。`,
        )
      }
      return { data, usage, model: modelId, warnings, ms: Date.now() - started, reasoningChars: reasoning.length }
    } catch (err) {
      // JSON 解析失败：追加一次「只输出 JSON」的纠正指令重试
      lastErr = new ApiError(`JSON 解析失败：${err.message}`, { status: 502, retryable: true })
      if (attempt < maxAttempts) {
        messages = [
          ...messages,
          { role: 'assistant', content: String(content).slice(0, 2000) },
          { role: 'user', content: '你上面的回复不是合法 JSON。请只输出一个合法的 JSON 对象，不要包含任何解释文字或 markdown 围栏。' },
        ]
        await sleep(backoffMs(attempt), signal).catch(() => {})
        continue
      }
      throw lastErr
    }
  }

  throw lastErr ?? new ApiError('未知错误')
}

function backoffMs(attempt) {
  const base = 700 * 2 ** (attempt - 1)
  return Math.min(base + Math.random() * 400, 15_000)
}

function explainStatus(status, body) {
  const hint =
    {
      400: '请求参数有误',
      401: 'API Key 无效或未授权，请检查页面「模型设置」里填写的密钥',
      402: '账户余额不足',
      403: '无权访问该模型，请检查模型名是否有权限使用',
      404: '接口或模型不存在，请检查 API 地址与模型名',
      422: '请求内容不被接受',
      429: '触发限流（请求过于频繁）',
      500: '服务端内部错误',
      502: '网关错误',
      503: '服务暂不可用',
      504: '网关超时',
    }[status] ?? '请求失败'
  return redactSecrets(`API ${status}：${hint}${body ? ` — ${body.slice(0, 300)}` : ''}`)
}

/**
 * 轻量连通性自检（不消耗生成额度）。
 * 用于界面上「测试连接」按钮：验证 Key 是否可用、以及能看到哪些模型。
 * @param {{apiKey:string,baseUrl:string}} [auth]
 */
export async function ping(auth) {
  const rt = auth ?? resolveRuntime()
  if (!rt.apiKey) {
    throw new ApiError('请先填写 API Key。', { status: 401 })
  }
  const res = await fetch(`${rt.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${rt.apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new ApiError(explainStatus(res.status, await res.text().catch(() => '')), { status: res.status })
  return res.json()
}
