/**
 * src/api-client.js 单元测试
 * 运行: node test/api-client.test.js
 */
const assert = require('assert')
const { ApiClient, ApiError } = require('../src/api-client')

let passed = 0
let failed = 0

function test(name, fn) {
  const run = async () => {
    try {
      await fn()
      passed++
      console.log(`  ✅ ${name}`)
    } catch (e) {
      failed++
      console.log(`  ❌ ${name}: ${e.message}`)
    }
  }
  return run()
}

// 构造 Response-like 对象（够 fetch 契约用即可）
function mockResponse({ status = 200, body = '', ok = null } = {}) {
  return {
    ok: ok == null ? (status >= 200 && status < 300) : ok,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  }
}

// 按调用序列喂 fetch 结果
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

  await test('GET 成功返回 JSON', async () => {
    const fetchImpl = makeFetch([mockResponse({ status: 200, body: { hello: 'world' } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    const r = await c.get('/api/ping')
    assert.deepStrictEqual(r, { hello: 'world' })
    assert.strictEqual(fetchImpl.calls[0].url, 'https://x.test/api/ping')
    assert.strictEqual(fetchImpl.calls[0].init.method, 'GET')
  })

  await test('POST body 自动 JSON.stringify', async () => {
    const fetchImpl = makeFetch([mockResponse({ status: 200, body: { ok: 1 } })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await c.post('/api/x', { a: 1, b: 'hi' })
    const init = fetchImpl.calls[0].init
    assert.strictEqual(init.method, 'POST')
    assert.strictEqual(init.body, '{"a":1,"b":"hi"}')
    assert.strictEqual(init.headers['Content-Type'], 'application/json')
  })

  await test('access_token 自动注入 Authorization 头', async () => {
    const fetchImpl = makeFetch([mockResponse({ status: 200, body: {} })])
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getAccessToken: () => 'abc123',
      fetchImpl,
    })
    await c.get('/api/user/profile')
    assert.strictEqual(fetchImpl.calls[0].init.headers['Authorization'], 'Bearer abc123')
  })

  await test('auth=false 时不注入 Authorization 头', async () => {
    const fetchImpl = makeFetch([mockResponse({ status: 200, body: {} })])
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getAccessToken: () => 'abc123',
      fetchImpl,
    })
    await c.post('/api/auth/login', { email: 'a@b.c' }, { auth: false })
    assert.ok(!fetchImpl.calls[0].init.headers['Authorization'])
  })

  await test('401 → 刷新 token → 重试成功', async () => {
    const fetchImpl = makeFetch([
      mockResponse({ status: 401, body: { code: 401, message: 'expired' } }),
      mockResponse({ status: 200, body: { ok: 1 } }),
    ])
    let token = 'old'
    let refreshCalls = 0
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getAccessToken: () => token,
      refreshAccessToken: async () => {
        refreshCalls++
        token = 'new'
        return token
      },
      fetchImpl,
    })
    const r = await c.get('/api/user/profile')
    assert.deepStrictEqual(r, { ok: 1 })
    assert.strictEqual(refreshCalls, 1)
    assert.strictEqual(fetchImpl.calls[1].init.headers['Authorization'], 'Bearer new')
  })

  await test('401 → refresh 失败 → 回调 onAuthFailed 并抛 UNAUTHORIZED', async () => {
    const fetchImpl = makeFetch([
      mockResponse({ status: 401, body: { message: 'expired' } }),
    ])
    let failedCalled = 0
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getAccessToken: () => 'old',
      refreshAccessToken: async () => null,
      onAuthFailed: () => { failedCalled++ },
      fetchImpl,
    })
    await assert.rejects(c.get('/x'), (e) => {
      return e instanceof ApiError && e.status === 401 && e.code === 'UNAUTHORIZED'
    })
    assert.strictEqual(failedCalled, 1)
  })

  await test('401 → refresh 后仍 401 → 回调 onAuthFailed', async () => {
    const fetchImpl = makeFetch([
      mockResponse({ status: 401, body: {} }),
      mockResponse({ status: 401, body: {} }),
    ])
    let failedCalled = 0
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getAccessToken: () => 'old',
      refreshAccessToken: async () => 'newbutstillbad',
      onAuthFailed: () => { failedCalled++ },
      fetchImpl,
    })
    await assert.rejects(c.get('/x'), (e) => e.status === 401)
    assert.strictEqual(failedCalled, 1)
  })

  await test('并发 401 只触发一次 refresh', async () => {
    const fetchImpl = makeFetch([
      mockResponse({ status: 401, body: {} }),
      mockResponse({ status: 401, body: {} }),
      mockResponse({ status: 200, body: { r: 1 } }),
      mockResponse({ status: 200, body: { r: 2 } }),
    ])
    let refreshCalls = 0
    const c = new ApiClient({
      baseUrl: 'https://x.test',
      getAccessToken: () => 'old',
      refreshAccessToken: async () => {
        refreshCalls++
        await new Promise(r => setTimeout(r, 10))
        return 'new'
      },
      fetchImpl,
    })
    const [a, b] = await Promise.all([c.get('/a'), c.get('/b')])
    assert.deepStrictEqual(a, { r: 1 })
    assert.deepStrictEqual(b, { r: 2 })
    assert.strictEqual(refreshCalls, 1)
  })

  await test('非 2xx 且带 message 时抛 ApiError 携带后端 message', async () => {
    const fetchImpl = makeFetch([
      mockResponse({ status: 400, body: { code: 10001, message: '邮箱已注册' } }),
    ])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await assert.rejects(c.post('/api/auth/register', {}, { auth: false }), (e) => {
      return e instanceof ApiError && e.status === 400 && e.code === 10001 && e.message === '邮箱已注册'
    })
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
    const fetchImpl = makeFetch([mockResponse({ status: 200, body: {} })])
    const c = new ApiClient({ baseUrl: 'https://x.test', fetchImpl })
    await c.get('https://other.test/abs', { auth: false })
    assert.strictEqual(fetchImpl.calls[0].url, 'https://other.test/abs')
  })

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`)
  if (failed > 0) process.exit(1)
}

run()
