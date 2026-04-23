/**
 * src/auth.js 单元测试
 * 运行: node test/auth.test.js
 * 使用 os.tmpdir() 下的临时文件，不触碰真实 U 盘或网络。
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

// Mock ApiClient：按 {method, path} 路由到响应或错误
function mockClient(routes = {}) {
  const calls = []
  const handle = (method) => async (p, body, opts) => {
    calls.push({ method, path: p, body, opts })
    const key = `${method} ${p}`
    const handler = routes[key]
    if (!handler) throw new Error(`unmocked: ${key}`)
    if (handler instanceof Error) throw handler
    if (typeof handler === 'function') return handler({ body, opts, calls })
    return handler
  }
  return {
    calls,
    get: (p, opts) => handle('GET')(p, undefined, opts),
    post: (p, body, opts) => handle('POST')(p, body, opts),
  }
}

async function run() {
  console.log('\n=== auth 测试 ===\n')

  await test('constructor 缺 authPath 抛错', async () => {
    assert.throws(() => new AuthManager({}), /authPath/)
  })

  await test('load: 文件不存在返回 false，state 为 null', async () => {
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
      assert.strictEqual(m.state, null)
    } finally { cleanup() }
  })

  await test('load: 版本不匹配返回 false', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      fs.writeFileSync(authPath, JSON.stringify({
        version: 99, access_token: 'a', refresh_token: 'r',
      }))
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), false)
    } finally { cleanup() }
  })

  await test('load: 缺 token 字段返回 false', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      fs.writeFileSync(authPath, JSON.stringify({
        version: AUTH_FILE_VERSION, access_token: 'a',
      }))
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), false)
    } finally { cleanup() }
  })

  await test('load: 合法数据恢复 state', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      fs.writeFileSync(authPath, JSON.stringify({
        version: AUTH_FILE_VERSION,
        access_token: 'AT_X',
        refresh_token: 'RT_X',
        user: { email: 'demo@example.com', nickname: 'demo' },
        saved_at: '2026-04-24T10:00:00.000Z',
      }))
      const m = new AuthManager({ authPath, apiClient: mockClient() })
      assert.strictEqual(await m.load(), true)
      assert.strictEqual(m.getAccessToken(), 'AT_X')
      assert.strictEqual(m.isLoggedIn(), true)
      assert.deepStrictEqual(m.getUserProfile(), { email: 'demo@example.com', nickname: 'demo' })
    } finally { cleanup() }
  })

  await test('sendCode: 调用 SEND_CODE 端点且 auth=false', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({ 'POST /api/auth/send-code': { code: 0 } })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.sendCode('demo@example.com')
      assert.strictEqual(client.calls.length, 1)
      assert.deepStrictEqual(client.calls[0].body, { email: 'demo@example.com' })
      assert.strictEqual(client.calls[0].opts.auth, false)
    } finally { cleanup() }
  })

  await test('login: 写 auth.json 且字段正确', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'AT1', refresh_token: 'RT1', expires_in: 7200 },
        'GET /api/user/profile': { email: 'demo@example.com', nickname: 'Demo' },
      })
      const m = new AuthManager({ authPath, apiClient: client })
      const r = await m.login({ email: 'demo@example.com', password: 'pw' })
      assert.deepStrictEqual(r.user, { email: 'demo@example.com', nickname: 'Demo' })
      assert.strictEqual(m.getAccessToken(), 'AT1')

      const saved = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      assert.strictEqual(saved.version, AUTH_FILE_VERSION)
      assert.strictEqual(saved.access_token, 'AT1')
      assert.strictEqual(saved.refresh_token, 'RT1')
      assert.deepStrictEqual(saved.user, { email: 'demo@example.com', nickname: 'Demo' })
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(saved.saved_at))
    } finally { cleanup() }
  })

  await test('login: profile 拉取失败时 user 只保留 email', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'AT2', refresh_token: 'RT2' },
        'GET /api/user/profile': new Error('network down'),
      })
      const m = new AuthManager({ authPath, apiClient: client })
      const r = await m.login({ email: 'demo@example.com', password: 'pw' })
      assert.deepStrictEqual(r.user, { email: 'demo@example.com' })
      assert.strictEqual(m.isLoggedIn(), true)
    } finally { cleanup() }
  })

  await test('login: 后端返回缺 token 抛错', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'only_access' },
      })
      const m = new AuthManager({ authPath, apiClient: client })
      await assert.rejects(m.login({ email: 'a@b.c', password: 'x' }), /token/)
      assert.strictEqual(m.isLoggedIn(), false)
    } finally { cleanup() }
  })

  await test('register: 调 REGISTER 后自动 login', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/register': { user_id: 1, email: 'demo@example.com' },
        'POST /api/auth/login': { access_token: 'AT3', refresh_token: 'RT3' },
        'GET /api/user/profile': { email: 'demo@example.com' },
      })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.register({ email: 'demo@example.com', password: 'pw', code: '123456' })
      assert.strictEqual(m.isLoggedIn(), true)
      const postCalls = client.calls.filter(c => c.method === 'POST').map(c => c.path)
      assert.deepStrictEqual(postCalls.slice(0, 2), ['/api/auth/register', '/api/auth/login'])
    } finally { cleanup() }
  })

  await test('logout: 调 LOGOUT 端点并删除 auth.json', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'AT4', refresh_token: 'RT4' },
        'GET /api/user/profile': { email: 'a@b.c' },
        'POST /api/auth/logout': { code: 0 },
      })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.login({ email: 'a@b.c', password: 'x' })
      assert.ok(fs.existsSync(authPath))
      await m.logout()
      assert.strictEqual(m.isLoggedIn(), false)
      assert.strictEqual(m.getAccessToken(), null)
      assert.strictEqual(fs.existsSync(authPath), false)
      const logoutCall = client.calls.find(c => c.path === '/api/auth/logout')
      assert.ok(logoutCall, 'logout 端点应被调用')
    } finally { cleanup() }
  })

  await test('logout: 后端失败也要清本地', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'AT', refresh_token: 'RT' },
        'GET /api/user/profile': { email: 'a@b.c' },
        'POST /api/auth/logout': new Error('500'),
      })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.login({ email: 'a@b.c', password: 'x' })
      await m.logout()
      assert.strictEqual(m.isLoggedIn(), false)
      assert.strictEqual(fs.existsSync(authPath), false)
    } finally { cleanup() }
  })

  await test('refreshAccessToken: 成功更新 access_token 并写盘', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'AT_OLD', refresh_token: 'RT_OLD' },
        'GET /api/user/profile': { email: 'a@b.c' },
        'POST /api/auth/refresh': { access_token: 'AT_NEW', expires_in: 7200 },
      })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.login({ email: 'a@b.c', password: 'x' })
      const newToken = await m.refreshAccessToken()
      assert.strictEqual(newToken, 'AT_NEW')
      assert.strictEqual(m.getAccessToken(), 'AT_NEW')
      const saved = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      assert.strictEqual(saved.access_token, 'AT_NEW')
      assert.strictEqual(saved.refresh_token, 'RT_OLD')
    } finally { cleanup() }
  })

  await test('refreshAccessToken: 返回轮换的 refresh_token 时一并更新', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'AT_OLD', refresh_token: 'RT_OLD' },
        'GET /api/user/profile': { email: 'a@b.c' },
        'POST /api/auth/refresh': { access_token: 'AT_NEW', refresh_token: 'RT_NEW' },
      })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.login({ email: 'a@b.c', password: 'x' })
      await m.refreshAccessToken()
      const saved = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      assert.strictEqual(saved.refresh_token, 'RT_NEW')
    } finally { cleanup() }
  })

  await test('refreshAccessToken: 失败清空状态', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient({
        'POST /api/auth/login': { access_token: 'AT', refresh_token: 'RT' },
        'GET /api/user/profile': { email: 'a@b.c' },
        'POST /api/auth/refresh': new Error('401'),
      })
      const m = new AuthManager({ authPath, apiClient: client })
      await m.login({ email: 'a@b.c', password: 'x' })
      assert.strictEqual(fs.existsSync(authPath), true)
      const r = await m.refreshAccessToken()
      assert.strictEqual(r, null)
      assert.strictEqual(m.isLoggedIn(), false)
      assert.strictEqual(fs.existsSync(authPath), false)
    } finally { cleanup() }
  })

  await test('refreshAccessToken: 未登录时直接返回 null', async () => {
    const { authPath, cleanup } = mkTmpAuthPath()
    try {
      const client = mockClient()
      const m = new AuthManager({ authPath, apiClient: client })
      const r = await m.refreshAccessToken()
      assert.strictEqual(r, null)
      assert.strictEqual(client.calls.length, 0)
    } finally { cleanup() }
  })

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`)
  if (failed > 0) process.exit(1)
}

run()
