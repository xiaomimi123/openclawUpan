/**
 * src/auth.js 单元测试（session cookie 模式）
 * 运行: node test/auth.test.js
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { AuthManager, AUTH_FILE_VERSION } = require('../src/auth')

let passed = 0
let failed = 0

function test(name, fn) {
  return (async () => {
    try {
      await fn()
      passed++
      console.log(`  ✅ ${name}`)
    } catch (e) {
      failed++
      console.log(`  ❌ ${name}: ${e.message}`)
    }
  })()
}

function mkTmpAuthPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-auth-test-'))
  return {
    dir,
    authPath: path.join(dir, 'auth.json'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} },
  }
}

// Mock ApiClient —— 注意：本文件里 mock 不是 ApiClient 类实例，是一个按 {method,path} 路由的对象
// 但关键是：auth.js 的 login 依赖 ApiClient 在响应 Set-Cookie 时调用 setCookie 回调
// mock 版本在 routes 里接入一个 simulateCookie 字段，handler 返回 data 的同时调用 setCookieOnLogin
function mockClient(routes = {}, opts = {}) {
  const calls = []
  const { onLoginResponse } = opts  // 额外：login 成功时模拟 setCookie 回调
  const handle = (method) => async (p, body, reqOpts) => {
    calls.push({ method, path: p, body, opts: reqOpts })
    const key = `${method} ${p}`
    if (!(key in routes)) throw new Error(`unmocked: ${key}`)
    const handler = routes[key]
    if (handler instanceof Error) throw handler
    const result = typeof handler === 'function' ? handler({ body, opts: reqOpts, calls }) : handler
    // 特殊：登录接口模拟 Set-Cookie 回调
    if (p === '/api/user/login' && onLoginResponse) onLoginResponse()
    return result
  }
  return {
    calls,
    get: (p, opts) => handle('GET')(p, undefined, opts),
    post: (p, body, opts) => handle('POST')(p, body, opts),
  }
}

async function run() {
  console.log('\n=== auth 测试（session 模式）===\n')

  await test('constructor 缺 authPath 抛错', async () => {
    assert.throws(() => new AuthManager({}), /authPath/)
  })

  await test('load: 文件不存在返回 false', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), false)
      assert.strictEqual(m.state, null)
      assert.strictEqual(m.isLoggedIn(), false)
    } finally { cleanup() }
  })

  await test('load: 坏 JSON 返回 false', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      fs.writeFileSync(authPath, 'not-json{')
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), false)
    } finally { cleanup() }
  })

  await test('load: 旧 v1 文件（access_token 格式）视为无效', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      // v1 用 access_token/refresh_token 字段
      fs.writeFileSync(authPath, JSON.stringify({
        version: 1,
        access_token: 'AT', refresh_token: 'RT',
      }))
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), false)
    } finally { cleanup() }
  })

  await test('load: 缺 session 字段返回 false', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      fs.writeFileSync(authPath, JSON.stringify({
        version: AUTH_FILE_VERSION, user: { id: 1 },
      }))
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), false)
    } finally { cleanup() }
  })

  await test('load: 合法 v2 数据恢复 state', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      fs.writeFileSync(authPath, JSON.stringify({
        version: AUTH_FILE_VERSION,
        session: 'session=abcxyz',
        user: { id: 6, username: 'demo', email: 'demo@example.com' },
        saved_at: '2026-04-24T10:00:00.000Z',
      }))
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), true)
      assert.strictEqual(m.getCookieString(), 'session=abcxyz')
      assert.strictEqual(m.isLoggedIn(), true)
      assert.strictEqual(m.getUserProfile().username, 'demo')
    } finally { cleanup() }
  })

  await test('sendCode: 调用 GET /api/verification?email=xxx auth=false', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({ 'GET /api/verification': { code: 0 } })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.sendCode('demo@example.com')
      assert.strictEqual(client.calls.length, 1)
      assert.strictEqual(client.calls[0].method, 'GET')
      assert.deepStrictEqual(client.calls[0].opts.query, { email: 'demo@example.com' })
      assert.strictEqual(client.calls[0].opts.auth, false)
    } finally { cleanup() }
  })

  await test('login: 写 auth.json 且字段正确（含 session）', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({
        authPath,
        apiClient: mockClient({
          'POST /api/user/login': { id: 6, username: 'demo', display_name: 'Demo' },
          'GET /api/user/self': { id: 6, username: 'demo', email: 'demo@example.com', quota: 0 },
        }, {
          onLoginResponse: () => {
            // 模拟 ApiClient 在解析 Set-Cookie 后调 setCookie
            m._updateSessionCookie('session=XYZ123')
          },
        }),
      })
      const r = await m.login({ username: 'demo@example.com', password: 'pw' })
      assert.strictEqual(r.user.email, 'demo@example.com')
      assert.strictEqual(m.getCookieString(), 'session=XYZ123')

      const saved = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      assert.strictEqual(saved.version, AUTH_FILE_VERSION)
      assert.strictEqual(saved.session, 'session=XYZ123')
      assert.strictEqual(saved.user.username, 'demo')
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(saved.saved_at))
    } finally { cleanup() }
  })

  await test('login: profile 拉取失败时登录仍然成功', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({
        authPath,
        apiClient: mockClient({
          'POST /api/user/login': { id: 6, username: 'demo' },
          'GET /api/user/self': new Error('network down'),
        }, {
          onLoginResponse: () => m._updateSessionCookie('session=XYZ123'),
        }),
      })
      const r = await m.login({ username: 'demo', password: 'pw' })
      assert.ok(r.user)
      assert.strictEqual(m.isLoggedIn(), true)
    } finally { cleanup() }
  })

  await test('login: 无 Set-Cookie 抛错', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({
        authPath,
        apiClient: mockClient({
          'POST /api/user/login': { id: 6, username: 'demo' },
        }),  // 不触发 onLoginResponse → 没有 session cookie
      })
      await assert.rejects(m.login({ username: 'demo', password: 'pw' }), /session/)
      assert.strictEqual(m.isLoggedIn(), false)
    } finally { cleanup() }
  })

  await test('register: 字段格式正确 + 后续自动 login', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({
        authPath,
        apiClient: mockClient({
          'POST /api/user/register': null,  // 灵镜AI 注册成功 data 可为 null
          'POST /api/user/login': { id: 7, username: 'demo' },
          'GET /api/user/self': { id: 7, username: 'demo', email: 'demo@example.com' },
        }, {
          onLoginResponse: () => m._updateSessionCookie('session=NEW'),
        }),
      })
      await m.register({
        username: 'demo',
        email: 'demo@example.com',
        password: 'pw',
        verification_code: '123456',
      })
      assert.strictEqual(m.isLoggedIn(), true)
      // 检查 register body 字段正确
      const reg = m.apiClient.calls.find(c => c.path === '/api/user/register')
      assert.strictEqual(reg.body.username, 'demo')
      assert.strictEqual(reg.body.email, 'demo@example.com')
      assert.strictEqual(reg.body.password, 'pw')
      assert.strictEqual(reg.body.password2, 'pw')
      assert.strictEqual(reg.body.verification_code, '123456')
    } finally { cleanup() }
  })

  await test('register: 缺字段抛错', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      await assert.rejects(m.register({ email: 'a@b.c', password: 'pw', verification_code: '1' }), /缺失/)
    } finally { cleanup() }
  })

  await test('logout: 调 GET /api/user/logout 并清本地', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({
        authPath,
        apiClient: mockClient({
          'POST /api/user/login': { id: 6, username: 'demo' },
          'GET /api/user/self': { id: 6, username: 'demo' },
          'GET /api/user/logout': { code: 0 },
        }, {
          onLoginResponse: () => m._updateSessionCookie('session=X'),
        }),
      })
      await m.login({ username: 'demo', password: 'pw' })
      assert.ok(fs.existsSync(authPath))
      await m.logout()
      assert.strictEqual(m.isLoggedIn(), false)
      assert.strictEqual(m.getCookieString(), null)
      assert.strictEqual(fs.existsSync(authPath), false)
      const logoutCall = m.apiClient.calls.find(c => c.path === '/api/user/logout')
      assert.ok(logoutCall && logoutCall.method === 'GET')
    } finally { cleanup() }
  })

  await test('logout: 后端失败也要清本地', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({
        authPath,
        apiClient: mockClient({
          'POST /api/user/login': { id: 6 },
          'GET /api/user/self': { id: 6 },
          'GET /api/user/logout': new Error('500'),
        }, {
          onLoginResponse: () => m._updateSessionCookie('session=X'),
        }),
      })
      await m.login({ username: 'demo', password: 'pw' })
      await m.logout()
      assert.strictEqual(m.isLoggedIn(), false)
      assert.strictEqual(fs.existsSync(authPath), false)
    } finally { cleanup() }
  })

  await test('_updateSessionCookie 直接更新 session 并落盘', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      m._updateSessionCookie('session=Y')
      assert.strictEqual(m.getCookieString(), 'session=Y')
      // save() 是异步的，等一小会儿确保落盘
      await new Promise(r => setTimeout(r, 50))
      const saved = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      assert.strictEqual(saved.session, 'session=Y')
    } finally { cleanup() }
  })

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`)
  if (failed > 0) process.exit(1)
}

run()
