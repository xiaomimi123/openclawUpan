/**
 * V5 中转站 HTTP 客户端（Cookie session + Bearer token 双模式）
 * 基于 global.fetch（Electron/Node 原生），零依赖
 *
 * 鉴权模式（通过 request 的 auth 参数指定）：
 *   - 'cookie'（默认）: 自动加 Cookie header，响应的 Set-Cookie 通过 setCookie 回调持久化
 *   - 'bearer':         用外部传入的 bearerToken 作 Authorization: Bearer <token>
 *   - false:            不加任何认证头
 *
 * 响应约定：后端统一 { success, message, data }，HTTP 永远 200
 *   - success === true  → 返回 data
 *   - success === false → 抛 ApiError(message)
 *
 * 网络错误 / 真正的非 200 → 抛 ApiError(status/code/message)
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
   * @param {string}                         [opts.baseUrl]
   * @param {() => string|null}              [opts.getCookie]     返回当前 "session=xxx" 格式
   * @param {(cookie: string|null) => void}  [opts.setCookie]     响应带 Set-Cookie 时回调存储
   * @param {() => void}                     [opts.onAuthFailed]  session 失效时回调
   * @param {typeof fetch}                   [opts.fetchImpl]     测试可注入 mock
   */
  constructor({
    baseUrl = API_HOST,
    getCookie = () => null,
    setCookie = () => {},
    onAuthFailed = () => {},
    fetchImpl = null,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.getCookie = getCookie
    this.setCookie = setCookie
    this.onAuthFailed = onAuthFailed
    this._fetch = fetchImpl || ((...a) => global.fetch(...a))
  }

  /**
   * @param {string} method GET|POST|PUT|DELETE
   * @param {string} path
   * @param {object} [opts]
   * @param {any}    [opts.body]         非 GET 时的请求体，自动 JSON.stringify
   * @param {object} [opts.query]        query string 参数
   * @param {'cookie'|'bearer'|false} [opts.auth='cookie']
   * @param {string} [opts.bearerToken]  auth='bearer' 时必须
   * @param {number} [opts.timeout]
   * @param {object} [opts.headers]
   * @param {boolean} [opts.unwrap=true] 自动解包 {success,data,message}。false 则返回原始体
   */
  async request(method, path, {
    body,
    query,
    auth = 'cookie',
    bearerToken = null,
    timeout = TIMEOUTS.DEFAULT,
    headers = {},
    unwrap = true,
  } = {}) {
    let url = /^https?:\/\//.test(path) ? path : this.baseUrl + path
    if (query && typeof query === 'object') {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v != null) qs.append(k, String(v))
      }
      const s = qs.toString()
      if (s) url += (url.includes('?') ? '&' : '?') + s
    }

    const h = { Accept: 'application/json', ...headers }
    if (body != null) h['Content-Type'] = 'application/json'

    if (auth === 'cookie') {
      const c = this.getCookie()
      if (c) h['Cookie'] = c
    } else if (auth === 'bearer') {
      if (!bearerToken) throw new Error('ApiClient: auth=bearer 需要 bearerToken')
      h['Authorization'] = 'Bearer ' + bearerToken
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)

    let res
    try {
      res = await this._fetch(url, {
        method,
        headers: h,
        body: body == null ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      throw new ApiError({
        status: 0,
        code: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: e.name === 'AbortError' ? '请求超时' : '网络请求失败：' + e.message,
      })
    } finally {
      clearTimeout(timer)
    }

    // 自动捕获 Set-Cookie（仅 cookie 模式且响应带 Set-Cookie）
    if (auth === 'cookie') {
      const setCookieHeader = pickSetCookie(res.headers)
      if (setCookieHeader) {
        const sessionCookie = extractSessionCookie(setCookieHeader)
        if (sessionCookie) this.setCookie(sessionCookie)
      }
    }

    // 解析响应体
    const text = await res.text()
    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }

    // 真正的 HTTP 错误（4xx/5xx，后端很少发，但兜底）
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailed()
      const msg = (data && typeof data === 'object' && data.message)
        ? data.message
        : `请求失败（HTTP ${res.status}）`
      throw new ApiError({
        status: res.status,
        code: (data && typeof data === 'object') ? data.code : null,
        message: msg,
      })
    }

    if (!unwrap) return data

    // 业务层成败判断（{ success, message, data } 约定）
    if (data && typeof data === 'object' && 'success' in data) {
      if (data.success) return data.data !== undefined ? data.data : data
      // 业务失败
      const msg = data.message || '请求失败'
      // 通用 session 失效关键词识别
      if (/登录|未登录|session/i.test(msg)) this.onAuthFailed()
      throw new ApiError({ status: 200, code: data.code || null, message: msg })
    }

    // 非标准响应，原样返回
    return data
  }

  get(path, opts)        { return this.request('GET',    path, opts) }
  post(path, body, opts) { return this.request('POST',   path, { ...opts, body }) }
  put(path, body, opts)  { return this.request('PUT',    path, { ...opts, body }) }
  del(path, opts)        { return this.request('DELETE', path, opts) }
}

// ─── Set-Cookie 解析工具 ────────────────────────────────────────────────
// Response.headers.get('set-cookie') 在 Node fetch 里只会返回第一条（合并的）；
// 多个 Set-Cookie 需要 .getSetCookie() 或 raw headers。我们只关心 session=xxx，用字符串匹配足够。

function pickSetCookie(headers) {
  if (!headers) return null
  // Node 20+: headers.getSetCookie()
  if (typeof headers.getSetCookie === 'function') {
    const arr = headers.getSetCookie()
    return arr && arr.length ? arr.join(',') : null
  }
  // 回退：get('set-cookie')（可能只拿到合并字符串）
  if (typeof headers.get === 'function') {
    return headers.get('set-cookie')
  }
  // mock header 对象（测试用）：直接读属性
  return headers['set-cookie'] || null
}

function extractSessionCookie(setCookieStr) {
  if (!setCookieStr) return null
  // 匹配 "session=<value>"，遇 ; 或 , 终止
  const m = setCookieStr.match(/(?:^|[;, ])session=([^;,]+)/i)
  if (!m) return null
  return 'session=' + m[1]
}

module.exports = { ApiClient, ApiError }
