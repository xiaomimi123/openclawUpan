/**
 * V5 登录态管理器（session cookie 模式）
 * 对接灵镜AI / new-api 后端，登录返回 Set-Cookie: session=xxx 持久化到 U 盘 auth.json。
 *
 * auth.json 结构（version 2）：
 * {
 *   "version": 2,
 *   "session": "session=<opaque cookie value>",
 *   "user": { "id": 6, "username": "xxx", "display_name": "xxx", "email": "xxx", "quota": 0, ... },
 *   "saved_at": "2026-04-24T10:00:00.000Z"
 * }
 */

const fs = require('fs')
const path = require('path')
const { ApiClient } = require('./api-client')
const { ENDPOINTS } = require('./api-config')

const AUTH_FILE_VERSION = 2

class AuthManager {
  /**
   * @param {object} opts
   * @param {string}      opts.authPath           U 盘 auth.json 绝对路径（必填）
   * @param {ApiClient}   [opts.apiClient]        外部注入；不传则自建并把 cookie 回调接回本实例
   * @param {() => void}  [opts.onAuthFailed]     session 失效时回调
   * @param {typeof fetch} [opts.fetchImpl]       自建 ApiClient 时透传
   */
  constructor({ authPath, apiClient = null, onAuthFailed = null, fetchImpl = null } = {}) {
    if (!authPath) throw new Error('AuthManager: authPath is required')
    this.authPath = authPath
    this.state = null  // { session, user, savedAt }
    this._onAuthFailed = onAuthFailed || (() => {})

    this.apiClient = apiClient || new ApiClient({
      getCookie: () => this.getCookieString(),
      setCookie: (c) => this._updateSessionCookie(c),
      onAuthFailed: () => {
        // session 失效 → 清状态 + 回调
        this.clear().catch(() => {})
        this._onAuthFailed()
      },
      fetchImpl,
    })
  }

  // ─── 持久化 ──────────────────────────────────────────────────────────────

  async load() {
    try {
      if (!fs.existsSync(this.authPath)) return false
      const raw = await fs.promises.readFile(this.authPath, 'utf8')
      const data = JSON.parse(raw)
      if (!data || data.version !== AUTH_FILE_VERSION) return false
      if (!data.session) return false
      this.state = {
        session: data.session,
        user: data.user || null,
        savedAt: data.saved_at || null,
      }
      return true
    } catch {
      return false
    }
  }

  async save() {
    if (!this.state) return
    const body = {
      version: AUTH_FILE_VERSION,
      session: this.state.session,
      user: this.state.user,
      saved_at: new Date().toISOString(),
    }
    await fs.promises.mkdir(path.dirname(this.authPath), { recursive: true })
    await fs.promises.writeFile(this.authPath, JSON.stringify(body, null, 2), 'utf8')
    this.state.savedAt = body.saved_at
  }

  async clear() {
    this.state = null
    try { await fs.promises.unlink(this.authPath) } catch {}
  }

  // ─── 内部：ApiClient 调 setCookie 时转发到本实例 ──────────────────────────
  _updateSessionCookie(cookieStr) {
    if (!cookieStr) return
    if (!this.state) this.state = { session: cookieStr, user: null, savedAt: null }
    else this.state.session = cookieStr
    // 异步保存，不阻塞
    this.save().catch(() => {})
  }

  // ─── 同步 getter ─────────────────────────────────────────────────────────

  getCookieString() {
    return (this.state && this.state.session) || null
  }

  isLoggedIn() {
    return !!(this.state && this.state.session)
  }

  getUserProfile() {
    return (this.state && this.state.user) || null
  }

  // ─── 认证动作 ────────────────────────────────────────────────────────────

  /** 发邮箱验证码（GET ?email=xxx，60s 限频由后端控制） */
  async sendCode(email) {
    await this.apiClient.get(ENDPOINTS.SEND_CODE, {
      auth: false,
      query: { email },
    })
    return { ok: true }
  }

  /**
   * 注册并自动登录
   * @param {object} p
   * @param {string} p.username
   * @param {string} p.email
   * @param {string} p.password
   * @param {string} p.verification_code
   */
  async register({ username, email, password, verification_code }) {
    if (!username || !email || !password || !verification_code) {
      throw new Error('Register payload missing required fields')
    }
    await this.apiClient.post(
      ENDPOINTS.REGISTER,
      { username, email, password, password2: password, verification_code },
      { auth: false }
    )
    // 注册成功后自动登录
    return await this.login({ username, password })
  }

  /**
   * 登录
   * @param {object} p
   * @param {string} p.username 邮箱或用户名都可（后端 username 字段接受两种）
   * @param {string} p.password
   */
  async login({ username, password }) {
    const data = await this.apiClient.post(
      ENDPOINTS.LOGIN,
      { username, password },
      { auth: false }  // 登录无 cookie，Set-Cookie 响应会被 ApiClient 自动捕获 → _updateSessionCookie
    )
    // 登录成功后 state.session 已由 _updateSessionCookie 写入
    if (!this.state || !this.state.session) {
      throw new Error('Login succeeded but no session cookie received')
    }
    this.state.user = data && typeof data === 'object' ? data : { username }
    await this.save()
    // 拉完整 profile（包含 email 字段等；失败不影响登录成功）
    try {
      const profile = await this.apiClient.get(ENDPOINTS.USER_SELF)
      if (profile && typeof profile === 'object') {
        this.state.user = profile
        await this.save()
      }
    } catch {}
    return { user: this.state.user }
  }

  /** 强制从后端拉最新 /api/user/self 更新状态（余额等会变化） */
  async refreshUserProfile() {
    if (!this.isLoggedIn()) return null
    try {
      const profile = await this.apiClient.get(ENDPOINTS.USER_SELF)
      if (profile && typeof profile === 'object') {
        this.state.user = profile
        await this.save()
        return profile
      }
    } catch {}
    return this.getUserProfile()
  }

  async logout() {
    if (this.isLoggedIn()) {
      try {
        await this.apiClient.get(ENDPOINTS.LOGOUT)
      } catch {}
    }
    await this.clear()
  }
}

module.exports = { AuthManager, AUTH_FILE_VERSION }
