/**
 * V5 中转站 HTTP 客户端
 * 基于 global.fetch（Electron/Node 原生），零依赖
 *
 * 特性：
 *   - 自动注入 Authorization: Bearer <access_token>
 *   - 401 → 自动调 refreshAccessToken() 换新 token → 重试一次
 *   - 并发 401 共享同一个 refresh 请求，避免重复刷新
 *   - 仍然 401 → 回调 onAuthFailed（让 UI 跳回登录页）
 *   - 所有错误统一抛 ApiError（带 status / code / message）
 */

const { API_HOST, TIMEOUTS } = require('./api-config')

class ApiError extends Error {
  constructor({ status = 0, code = null, message = '请求失败' } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

class ApiClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]            默认 API_HOST
   * @param {() => string|null} [opts.getAccessToken]       读当前 access_token
   * @param {() => Promise<string|null>} [opts.refreshAccessToken]  换新 token
   * @param {() => void} [opts.onAuthFailed]   refresh 失败时回调
   * @param {typeof fetch} [opts.fetchImpl]    可注入 mock fetch（测试用）
   */
  constructor({
    baseUrl = API_HOST,
    getAccessToken = () => null,
    refreshAccessToken = async () => null,
    onAuthFailed = () => {},
    fetchImpl = null,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.getAccessToken = getAccessToken
    this.refreshAccessToken = refreshAccessToken
    this.onAuthFailed = onAuthFailed
    this._fetch = fetchImpl || ((...a) => global.fetch(...a))
    this._refreshing = null  // 并发 401 共享
  }

  async request(method, path, { body, auth = true, timeout = TIMEOUTS.DEFAULT, headers = {} } = {}) {
    const url = /^https?:\/\//.test(path) ? path : this.baseUrl + path

    const doFetch = async () => {
      const h = { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }
      if (auth) {
        const t = this.getAccessToken()
        if (t) h['Authorization'] = 'Bearer ' + t
      }
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeout)
      try {
        return await this._fetch(url, {
          method,
          headers: h,
          body: body == null ? undefined : JSON.stringify(body),
          signal: ac.signal,
        })
      } finally {
        clearTimeout(timer)
      }
    }

    const toApiError = (e) => new ApiError({
      status: 0,
      code: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: e.name === 'AbortError' ? '请求超时' : '网络请求失败：' + e.message,
    })

    let res
    try { res = await doFetch() } catch (e) { throw toApiError(e) }

    // 401 → 刷新 token + 重试一次
    if (res.status === 401 && auth) {
      const newToken = await this._sharedRefresh()
      if (newToken) {
        try { res = await doFetch() } catch (e) { throw toApiError(e) }
      }
      if (res.status === 401) {
        this.onAuthFailed()
        throw new ApiError({ status: 401, code: 'UNAUTHORIZED', message: '登录已失效，请重新登录' })
      }
    }

    // 解析响应体
    let data = null
    const text = await res.text()
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }

    if (!res.ok) {
      const code = (data && typeof data === 'object') ? data.code : null
      const message = (data && typeof data === 'object' && data.message)
        ? data.message
        : `请求失败（HTTP ${res.status}）`
      throw new ApiError({ status: res.status, code, message })
    }
    return data
  }

  async _sharedRefresh() {
    if (!this._refreshing) {
      this._refreshing = Promise.resolve()
        .then(() => this.refreshAccessToken())
        .catch(() => null)
        .finally(() => { this._refreshing = null })
    }
    return this._refreshing
  }

  get(path, opts)        { return this.request('GET',    path, opts) }
  post(path, body, opts) { return this.request('POST',   path, { ...opts, body }) }
  put(path, body, opts)  { return this.request('PUT',    path, { ...opts, body }) }
  del(path, opts)        { return this.request('DELETE', path, opts) }
}

module.exports = { ApiClient, ApiError }
