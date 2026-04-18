/**
 * src/log-translate.js 单元测试
 * 运行: node test/log-translate.test.js
 */
const assert = require('assert')
const { translateLog } = require('../src/log-translate')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ❌ ${name}: ${e.message}`)
  }
}

console.log('\n=== log-translate 测试 ===\n')

test('空字符串返回 null', () => {
  assert.strictEqual(translateLog(''), null)
  assert.strictEqual(translateLog('   '), null)
})

test('无匹配规则返回 null', () => {
  assert.strictEqual(translateLog('Gateway started on port 18789'), null)
})

test('Config invalid → 追加修复提示', () => {
  const result = translateLog('Error: Config invalid')
  assert.ok(result)
  assert.ok(result.append)
  assert.ok(result.append.includes('自动修复'))
})

test('Unrecognized key → 隐藏', () => {
  const result = translateLog('Unrecognized key: tools')
  assert.deepStrictEqual(result, { hide: true })
})

test('schema 详情行 → 隐藏', () => {
  // 输入带前导空格，translateLog 先 trim 再匹配
  assert.deepStrictEqual(translateLog('  - <root>: something'), { hide: true })
  assert.deepStrictEqual(translateLog('  - agents.defaults: bad'), { hide: true })
  // 直接传 trim 后的内容也能匹配
  assert.deepStrictEqual(translateLog('- <root>: Unrecognized'), { hide: true })
})

test('Run: openclaw doctor → 隐藏', () => {
  assert.deepStrictEqual(translateLog('Run: openclaw doctor --fix'), { hide: true })
})

test('File: ~ 开头 → 隐藏', () => {
  assert.deepStrictEqual(translateLog('File: ~/.openclaw/openclaw.json'), { hide: true })
})

test('Problem: → 隐藏', () => {
  assert.deepStrictEqual(translateLog('Problem: Invalid config'), { hide: true })
})

test('ETIMEDOUT → 网络提示', () => {
  const result = translateLog('Error: connect ETIMEDOUT 104.21.55.2:443')
  assert.ok(result.append.includes('网络'))
})

test('EADDRINUSE → 端口提示', () => {
  const result = translateLog('Error: listen EADDRINUSE: address already in use')
  assert.ok(result.append.includes('端口'))
})

test('ERR_MODULE_NOT_FOUND → 文件不完整', () => {
  const result = translateLog('ERR_MODULE_NOT_FOUND: Cannot find package tslog')
  assert.ok(result.append.includes('程序文件不完整'))
})

test('EPERM → 权限提示', () => {
  const result = translateLog('Error: EPERM: operation not permitted')
  assert.ok(result.append.includes('文件访问被拒绝'))
})

test('ENOSPC → 磁盘空间', () => {
  const result = translateLog('Error: ENOSPC: no space left on device')
  assert.ok(result.append.includes('磁盘空间'))
})

test('Gateway start blocked → 修复提示', () => {
  const result = translateLog('Gateway start blocked by invalid config')
  assert.ok(result.append.includes('自动修复'))
})

test('fetch failed → 网络请求', () => {
  const result = translateLog('TypeError: fetch failed')
  assert.ok(result.append.includes('网络'))
})

test('Missing config → 恢复提示', () => {
  const result = translateLog('Missing config. Run openclaw setup')
  assert.ok(result.append.includes('自动恢复'))
})

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`)
process.exit(failed > 0 ? 1 : 0)
