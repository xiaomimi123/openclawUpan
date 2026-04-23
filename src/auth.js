/**
 * V5 登录态管理器
 * - 状态保存在 U 盘根目录 auth.json
 * - 登录/注册/登出/token 自动刷新
 * - 与 ApiClient 搭配：把 getAccessToken / refreshAccessToken / onAuthFailed 回调注入 ApiClient
 *
 * auth.json 结构：
 * {
 *   "version": 1,
 *   "access_token": "...",
 *   "refresh_token": "...",
 *   "user": { "email": "...", "nickname": "..." },
 *   "saved_at": "2026-04-24T10:00:00.000Z"
 * }
 */

const fs = require('fs')
const path = require('path')
const { ApiClient } = require('./api-client')
const { ENDPOINTS } = require('./api-config')

const AUTH_FILE_VERSION = 1

class AuthManager {
  /**
   * @param {object} opts
   * @param {string} opts.authPath              U 盘 auth.json 绝对路径（必填，便于测试）
   * @param {ApiClient} [opts.apiClient]        外部注入的 ApiClient；不传则自建并把回调接回本实例
   * @param {() => void} [opts.onAuthFailed]    refresh 失败时回调（通知 UI 跳登录）
   * @param {typeof fetch} [opts.fetchImpl]     自建 ApiClient 时透传给 fetchImpl
   */
  constructor({ authPath, apiClient = null, onAuthFailed = null, fetchImpl = null } = {}) {
    if (!authPath) throw new Error('AuthManager: authPath 必填')
    this.authPath = authPath
    this.state = null  // { accessToken, refreshToken, user, savedAt }
    this._onAuthFailed = onAuthFailed || (() => {})

    this.apiClient = apiClient || new ApiClient({
      getAccessToken: () => this.getAccessToken(),
      refreshAccessToken: () => this.refreshAccessToken(),
      onAuthFailed: () => this._onAuthFailed(),
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
      if (!data.access_token || !data.refresh_token) return false
      this.state = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
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
      access_token: this.state.accessToken,
      refresh_token: this.state.refreshToken,
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

  // ─── 同步 getter ─────────────────────────────────────────────────────────

  getAccessToken() {
    return (this.state && this.state.accessToken) || null
  }

  isLoggedIn() {
    return !!(this.state && this.state.refreshToken)
  }

  getUserProfile() {
    return (this.state && this.state.user) || null
  }

  // ─── 认证动作 ────────────────────────────────────────────────────────────

  async sendCode(email) {
    await this.apiClient.post(ENDPOINTS.SEND_CODE, { email }, { auth: false })
    return { ok: true }
  }

  async register({ email, password, code }) {
    await this.apiClient.post(
      ENDPOINTS.REGISTER,
      { email, password, code },
      { auth: false }
    )
    // 注册接口只返回 { user_id, email }，不返回 token → 注册成功后自动登录
    return await this.login({ email, password })
  }

  async login({ email, password }) {
    const r = await this.apiClient.post(
      ENDPOINTS.LOGIN,
      { email, password },
      { auth: false }
    )
    if (!r || !r.access_token || !r.refresh_token) {
      throw new Error('登录返回数据缺少 token 字段')
    }
    this.state = {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      user: { email },
      savedAt: null,
    }
    await this.save()
    // 登录成功后异步拉完整 profile（失败不影响登录成功）
    try {
      const profile = await this.apiClient.get(ENDPOINTS.USER_PROFILE)
      if (profile && typeof profile === 'object') {
        this.state.user = profile
        await this.save()
      }
    } catch {}
    return { user: this.state.user }
  }

  async logout() {
    if (this.state && this.state.refreshToken) {
      try {
        await this.apiClient.post(ENDPOINTS.LOGOUT, {})
      } catch {}
    }
    await this.clear()
  }

  async refreshAccessToken() {
    if (!this.state || !this.state.refreshToken) return null
    try {
      const r = await this.apiClient.post(
        ENDPOINTS.REFRESH,
        { refresh_token: this.state.refreshToken },
        { auth: false }
      )
      if (!r || !r.access_token) throw new Error('refresh 返回缺少 access_token')
      this.state.accessToken = r.access_token
      if (r.refresh_token) this.state.refreshToken = r.refresh_token
      await this.save()
      return this.state.accessToken
    } catch {
      await this.clear()
      return null
    }
  }
}

module.exports = { AuthManager, AUTH_FILE_VERSION }
