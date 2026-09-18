/**
 * 模型设置面板：让用户在网页里自己填 DeepSeek API Key。
 *
 * 存储策略（用户可选）：
 *   - 记住 → localStorage（关掉浏览器再来也不用重填）
 *   - 不记住 → sessionStorage（关掉标签页即消失）
 * 两者都只存在用户自己的浏览器里。服务端不接收、不保存，只在单次请求内使用。
 */
import * as api from './api.js'

const STORE_KEY = 'agreement-reader:credentials:v1'

/** @returns {{apiKey:string, baseUrl:string, model:string, modelSummary:string, remember:boolean}} */
export function loadCredentials() {
  for (const [store, remember] of [
    [localStorage, true],
    [sessionStorage, false],
  ]) {
    try {
      const raw = store.getItem(STORE_KEY)
      if (!raw) continue
      const v = JSON.parse(raw)
      if (v && typeof v === 'object') {
        return {
          apiKey: String(v.apiKey ?? '').trim(),
          baseUrl: String(v.baseUrl ?? '').trim(),
          model: String(v.model ?? '').trim(),
          modelSummary: String(v.modelSummary ?? '').trim(),
          remember,
        }
      }
    } catch {
      /* 读不到就换下一个 */
    }
  }
  return { apiKey: '', baseUrl: '', model: '', modelSummary: '', remember: true }
}

export function saveCredentials(creds) {
  const payload = JSON.stringify({
    apiKey: (creds.apiKey ?? '').trim(),
    baseUrl: (creds.baseUrl ?? '').trim(),
    model: (creds.model ?? '').trim(),
    modelSummary: (creds.modelSummary ?? '').trim(),
  })
  clearCredentials()
  try {
    if (creds.remember) localStorage.setItem(STORE_KEY, payload)
    else sessionStorage.setItem(STORE_KEY, payload)
  } catch {
    throw new Error('浏览器存储不可用，密钥无法被记住（本次使用不受影响）。')
  }
}

export function clearCredentials() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* 忽略 */
  }
  try {
    sessionStorage.removeItem(STORE_KEY)
  } catch {
    /* 忽略 */
  }
}

/**
 * @param {object} p
 * @param {Record<string, HTMLElement>} p.dom
 * @param {(creds:object)=>void} p.onSaved
 * @param {(msg:string, isError?:boolean)=>void} p.toast
 * @param {()=>boolean} [p.serverHasKey] 服务端是否已通过 .env 配好密钥
 */
export function createSettingsPanel({ dom, onSaved, toast, serverHasKey }) {
  let creds = loadCredentials()

  const setStatus = (message, kind = '') => {
    if (!message) {
      dom.settingsStatus.classList.add('hidden')
      dom.settingsStatus.innerHTML = ''
      return
    }
    dom.settingsStatus.className = `settings-status ${kind}`
    dom.settingsStatus.innerHTML = message
  }

  const readFields = () => ({
    apiKey: dom.setKey.value.trim(),
    baseUrl: dom.setBaseUrl.value.trim(),
    model: dom.setModel.value.trim(),
    modelSummary: dom.setModelSummary.value.trim(),
    remember: dom.setRemember.checked,
  })

  const fillFields = (c) => {
    dom.setKey.value = c.apiKey ?? ''
    dom.setBaseUrl.value = c.baseUrl ?? ''
    dom.setModel.value = c.model ?? ''
    dom.setModelSummary.value = c.modelSummary ?? ''
    dom.setRemember.checked = c.remember !== false
  }

  // ---- 显示 / 隐藏密钥 ----
  dom.btnToggleKey.addEventListener('click', () => {
    const showing = dom.setKey.type === 'text'
    dom.setKey.type = showing ? 'password' : 'text'
    dom.btnToggleKey.textContent = showing ? '显示' : '隐藏'
  })

  // ---- 测试连接 ----
  dom.btnTestKey.addEventListener('click', async () => {
    const c = readFields()
    if (!c.apiKey) {
      setStatus('请先填写 API Key。', 'is-bad')
      return
    }
    dom.btnTestKey.disabled = true
    dom.btnTestKey.textContent = '测试中…'
    setStatus('正在连接…')
    try {
      const res = await api.verifyKey(c)
      const models = res.models ?? []
      if (models.length) {
        dom.modelSuggestions.innerHTML = models.map((m) => `<option value="${m}"></option>`).join('')
      }
      const available = res.modelAvailable === false ? '（注意：当前填写的模型不在可见列表中）' : ''
      setStatus(
        `✅ 连接成功，密钥可用（${res.keyHint ?? ''}）<br>接口：${res.baseUrl}<br>可见模型：${
          models.length ? models.slice(0, 12).join('、') : '未返回模型列表'
        } ${available}`,
        'is-ok',
      )
    } catch (err) {
      setStatus(`❌ 连接失败：${err.message}`, 'is-bad')
    } finally {
      dom.btnTestKey.disabled = false
      dom.btnTestKey.textContent = '测试连接'
    }
  })

  // ---- 保存 ----
  dom.btnSettingsSave.addEventListener('click', () => {
    const c = readFields()
    if (!c.apiKey) {
      setStatus('请先填写 API Key。', 'is-bad')
      return
    }
    try {
      saveCredentials(c)
    } catch (err) {
      toast(err.message, true)
    }
    creds = loadCredentials()
    onSaved(creds)
    setStatus('')
    dom.dialog.close()
    toast('已保存，后续分析将使用真实模型')
  })

  // ---- 清除 ----
  dom.btnSettingsClear.addEventListener('click', () => {
    if (!confirm('确定要清除已保存的 API Key 吗？')) return
    clearCredentials()
    creds = { apiKey: '', baseUrl: '', model: '', modelSummary: '', remember: true }
    fillFields(creds)
    setStatus('')
    onSaved(creds)
    toast('已清除密钥，将回到本地规则模式')
  })

  dom.btnSettingsClose.addEventListener('click', () => dom.dialog.close())
  dom.dialog.addEventListener('close', () => setStatus(''))

  return {
    /** 打开设置面板 */
    open() {
      creds = loadCredentials()
      fillFields(creds)
      setStatus('')
      // 说清楚"到底在用哪把钥匙"，避免用户困惑
      if (!dom.setKey.value && serverHasKey?.()) {
        setStatus('服务端已通过 .env 配置了 API Key，此处留空即使用服务端的那把。')
      }
      dom.dialog.showModal()
    },
    /** 服务端下发模型建议时填充候选项 */
    setModelSuggestions(list) {
      const models = (list ?? []).filter(Boolean)
      if (models.length) {
        dom.modelSuggestions.innerHTML = models.map((m) => `<option value="${m}"></option>`).join('')
      }
    },
    get credentials() {
      return loadCredentials()
    },
  }
}
