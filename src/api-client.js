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
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

/**
 * 原生 Node https.request 封装成 fetch 风格
 * 目的：彻底绕过 Electron main 的 Chromium fetch（会过滤 Set-Cookie）
 * 返回的 Response-like 对象兼容 fetch 契约：{ ok, status, headers, text() }
 */
function nodeHttpsFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const method = (init.method || 'GET').toUpperCase()
    const headers = { ...(init.headers || {}) }
    const bodyStr = init.body
    if (bodyStr != null && !headers['Content-Length']) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr)
    }
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: {
            get: (k) => {
              const v = res.headers[k.toLowerCase()]
              if (Array.isArray(v)) return v.join(', ')
              return v == null ? null : String(v)
            },
            getSetCookie: () => {
              const sc = res.headers['set-cookie']
              return Array.isArray(sc) ? sc : (sc ? [String(sc)] : [])
            },
            entries: function* () {
              for (const [k, v] of Object.entries(res.headers)) {
                if (Array.isArray(v)) for (const vv of v) yield [k, String(vv)]
                else yield [k, String(v)]
              }
            },
          },
          text: async () => body,
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy(new AbortError())
        return
      }
      init.signal.addEventListener('abort', () => {
        req.destroy(new AbortError())
      })
    }
    if (bodyStr != null) req.write(bodyStr)
    req.end()
  })
}

class AbortError extends Error {
  constructor() { super('aborted'); this.name = 'AbortError' }
}

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
    // Electron main 的 global.fetch 走 Chromium 栈会过滤 Set-Cookie
    // → 默认改用 Node 原生 https.request，Set-Cookie 完整可见
    this._fetch = fetchImpl || nodeHttpsFetch
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

const DEBUG_COOKIE = process.env.OPENCLAW_DEBUG_COOKIE === '1'

function pickSetCookie(headers) {
  if (!headers) {
    if (DEBUG_COOKIE) console.log('[cookie-debug] headers is null/undefined')
    return null
  }
  // Node 20+: headers.getSetCookie() 返回数组
  if (typeof headers.getSetCookie === 'function') {
    const arr = headers.getSetCookie()
    if (DEBUG_COOKIE) console.log('[cookie-debug] getSetCookie():', JSON.stringify(arr))
    if (arr && arr.length) return arr.join('\n')  // 用换行隔开避免被 Expires 里的逗号搞乱
  }
  // entries() 遍历（兼容 Chromium fetch 的 Headers）
  if (typeof headers.entries === 'function') {
    const pieces = []
    for (const [k, v] of headers.entries()) {
      if (k.toLowerCase() === 'set-cookie') pieces.push(v)
    }
    if (DEBUG_COOKIE) console.log('[cookie-debug] entries set-cookie pieces:', pieces)
    if (pieces.length) return pieces.join('\n')
  }
  // get('set-cookie') 回退
  if (typeof headers.get === 'function') {
    const v = headers.get('set-cookie')
    if (DEBUG_COOKIE) console.log('[cookie-debug] get(set-cookie):', v)
    if (v) return v
  }
  // 最终回退：直接读属性（mock/特殊对象）
  const raw = headers['set-cookie'] || null
  if (DEBUG_COOKIE) console.log('[cookie-debug] raw[set-cookie]:', raw)
  return raw
}

function extractSessionCookie(setCookieStr) {
  if (!setCookieStr) return null
  // 匹配 "session=<value>"，遇 ; 或 , 终止
  const m = setCookieStr.match(/(?:^|[;, ])session=([^;,]+)/i)
  if (!m) return null
  return 'session=' + m[1]
}

module.exports = { ApiClient, ApiError }
