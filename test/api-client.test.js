/**
 * src/api-client.js 单元测试
 * 运行: node test/api-client.test.js
 */
const assert = require('assert')
const { ApiClient, ApiError } = require('../src/api-client')

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

// 构造 Response-like 对象（模拟灵镜AI {success,message,data} 形态）
function mockResponse({ status = 200, body = null, headers = {}, ok = null } = {}) {
  return {
    ok: ok == null ? (status >= 200 && status < 300) : ok,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] || null,
      getSetCookie: () => headers['set-cookie'] ? [headers['set-cookie']] : [],
    },
    text: async () => {
      if (body == null) return ''
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

function makeFetch(sequence) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const next = sequence.shift()
    if (!next) throw new Error('mock fetch 耗尽')
    if (next instanceof Error) throw next
    return next
  }
  fn.calls = calls
  return fn
}

async function run() {
  console.log('\n=== api-client 测试 ===\n')

  await test('GET 成功解包 {success,data}', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: { hello: 'world' }, message: '' } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    const r = await c.get('/api/ping', { auth: false })
    assert.deepStrictEqual(r, { hello: 'world' })
  })

  await test('业务 success=false 抛 ApiError 携带 message', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: false, message: '用户名或密码错误' } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await assert.rejects(c.post('/api/user/login', { username: 'x' }, { auth: false }), (e) => {
      return e instanceof ApiError && e.status === 200 && e.message === '用户名或密码错误'
    })
  })

  await test('unwrap=false 返回原始响应体', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: { x: 1 }, extra: 'kept' } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    const r = await c.get('/api/raw', { auth: false, unwrap: false })
    assert.deepStrictEqual(r, { success: true, data: { x: 1 }, extra: 'kept' })
  })

  await test('POST body 自动 JSON.stringify', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: null } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await c.post('/api/x', { a: 1, b: 'hi' }, { auth: false })
    const init = fetchImpl.calls[0].init
    assert.strictEqual(init.method, 'POST')
    assert.strictEqual(init.body, '{"a":1,"b":"hi"}')
    assert.strictEqual(init.headers['Content-Type'], 'application/json')
  })

  await test('query 参数拼到 URL', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: null } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await c.get('/api/verification', { auth: false, query: { email: 'a@b.c' } })
    assert.strictEqual(fetchImpl.calls[0].url, 'https://x.test/api/verification?email=a%40b.c')
  })

  await test('auth=cookie 自动加 Cookie header', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: null } })])
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getCookie: () => 'session=abc123',
      fetchImpl,
    })
    await c.get('/api/user/self')
    assert.strictEqual(fetchImpl.calls[0].init.headers['Cookie'], 'session=abc123')
  })

  await test('auth=false 时不加 Cookie 头', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: null } })])
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getCookie: () => 'session=abc123',
      fetchImpl,
    })
    await c.post('/api/user/login', { x: 1 }, { auth: false })
    assert.ok(!fetchImpl.calls[0].init.headers['Cookie'])
  })

  await test('auth=bearer 加 Authorization 头', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: null } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await c.get('/v1/models', { auth: 'bearer', bearerToken: 'sk-abc', unwrap: false })
    assert.strictEqual(fetchImpl.calls[0].init.headers['Authorization'], 'Bearer sk-abc')
    assert.ok(!fetchImpl.calls[0].init.headers['Cookie'])
  })

  await test('auth=bearer 缺 bearerToken 抛错', async () => {
    const fetchImpl = makeFetch([])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await assert.rejects(c.get('/v1/models', { auth: 'bearer' }), /bearerToken/)
  })

  await test('auth=false 登录也能捕获 Set-Cookie（关键：登录时 auth=false，响应 Set-Cookie 必须被存）', async () => {
    let captured = null
    const fetchImpl = makeFetch([mockResponse({
      body: { success: true, data: { id: 6, username: 'x' } },
      headers: { 'set-cookie': 'session=abc123xyz; Path=/; Max-Age=2592000' },
    })])
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      setCookie: (v) => { captured = v },
      fetchImpl,
    })
    await c.post('/api/user/login', { username: 'a', password: 'b' }, { auth: false })
    assert.strictEqual(captured, 'session=abc123xyz')
  })

  await test('auth=bearer 模式不捕获 Set-Cookie（bearer 与 cookie 世界隔离）', async () => {
    let captured = null
    const fetchImpl = makeFetch([mockResponse({
      body: { success: true, data: null },
      headers: { 'set-cookie': 'session=should_not_capture; Path=/' },
    })])
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      setCookie: (v) => { captured = v },
      fetchImpl,
    })
    await c.get('/v1/models', { auth: 'bearer', bearerToken: 'sk-abc', unwrap: false })
    assert.strictEqual(captured, null)
  })

  await test('登录用 auth=cookie 且无初始 cookie → 响应 Set-Cookie 被捕获', async () => {
    let captured = null
    const fetchImpl = makeFetch([mockResponse({
      body: { success: true, data: { id: 6 } },
      headers: { 'set-cookie': 'session=abc123xyz; Path=/; Max-Age=2592000' },
    })])
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getCookie: () => null,  // 登录前无 cookie
      setCookie: (v) => { captured = v },
      fetchImpl,
    })
    await c.post('/api/user/login', { username: 'a', password: 'b' })  // 默认 auth=cookie
    assert.strictEqual(captured, 'session=abc123xyz')
  })

  await test('业务失败含"登录"关键词 → 触发 onAuthFailed', async () => {
    const fetchImpl = makeFetch([mockResponse({
      body: { success: false, message: '请先登录' },
    })])
    let authFailedCalled = 0
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getCookie: () => 'session=stale',
      onAuthFailed: () => { authFailedCalled++ },
      fetchImpl,
    })
    await assert.rejects(c.get('/api/user/self'))
    assert.strictEqual(authFailedCalled, 1)
  })

  await test('HTTP 401 → 触发 onAuthFailed', async () => {
    const fetchImpl = makeFetch([mockResponse({ status: 401, body: { message: 'unauthorized' } })])
    let authFailedCalled = 0
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      onAuthFailed: () => { authFailedCalled++ },
      fetchImpl,
    })
    await assert.rejects(c.get('/x'), (e) => e.status === 401)
    assert.strictEqual(authFailedCalled, 1)
  })

  await test('网络错误 → NETWORK_ERROR', async () => {
    const fetchImpl = makeFetch([new Error('ECONNREFUSED')])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await assert.rejects(c.get('/x', { auth: false }), (e) => {
      return e instanceof ApiError && e.status === 0 && e.code === 'NETWORK_ERROR'
    })
  })

  await test('超时 → TIMEOUT', async () => {
    const fetchImpl = async (_url, init) => {
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await assert.rejects(c.get('/x', { auth: false, timeout: 20 }), (e) => {
      return e instanceof ApiError && e.code === 'TIMEOUT'
    })
  })

  await test('绝对 URL 不加 baseUrl 前缀', async () => {
    const fetchImpl = makeFetch([mockResponse({ body: { success: true, data: null } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await c.get('https://other.test/abs', { auth: false })
    assert.strictEqual(fetchImpl.calls[0].url, 'https://other.test/abs')
  })

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`)
  if (failed > 0) process.exit(1)
}

run()
