/**
 * src/config.js 单元测试（仅测试纯函数部分）
 * 运行: node test/config.test.js
 */

const path = require('path')
const os = require('os')

// Mock electron 和 paths
const Module = require('module')
const originalResolve = Module._resolveFilename
Module._resolveFilename = function(request, parent, ...args) {
  if (request === './paths' && parent && parent.filename && parent.filename.includes('config.js')) {
    return path.join(__dirname, '_mock_paths.js')
  }
  return originalResolve.call(this, request, parent, ...args)
}

const fs = require('fs')
const mockPathsFile = path.join(__dirname, '_mock_paths.js')
fs.writeFileSync(mockPathsFile, `
module.exports = {
  configDir: '${path.join(os.tmpdir(), 'openclaw-key-test', '.openclaw').replace(/\\/g, '\\\\')}',
  installDir: '${path.join(os.tmpdir(), 'openclaw-key-test').replace(/\\/g, '\\\\')}',
  setupFile: '${path.join(os.tmpdir(), 'openclaw-key-test', 'setup.json').replace(/\\/g, '\\\\')}',
}
`, 'utf8')

const assert = require('assert')
const { baseModelEntry, applyProviderConfig, buildOpenclawConfig } = require('../src/config')

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

console.log('\n=== config 测试 ===\n')

test('baseModelEntry 返回正确结构', () => {
  const entry = baseModelEntry('deepseek-chat', 'DeepSeek Chat')
  assert.strictEqual(entry.id, 'deepseek-chat')
  assert.strictEqual(entry.name, 'DeepSeek Chat')
  assert.strictEqual(entry.api, 'openai-completions')
  assert.strictEqual(entry.contextWindow, 128000)
  assert.strictEqual(entry.maxTokens, 8192)
})

test('anthropic: 设置 ANTHROPIC_API_KEY 和 model', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'anthropic', 'sk-ant-xxx')
  assert.strictEqual(cfg.env.ANTHROPIC_API_KEY, 'sk-ant-xxx')
  assert.strictEqual(cfg.agents.defaults.model.primary, 'anthropic/claude-sonnet-4-6')
})

test('anthropic + baseUrl: 设置 ANTHROPIC_BASE_URL', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'anthropic', 'sk-ant-xxx', { baseUrl: 'https://proxy.example.com' })
  assert.strictEqual(cfg.env.ANTHROPIC_BASE_URL, 'https://proxy.example.com')
})

test('openai 无 baseUrl: 设置 OPENAI_API_KEY', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'openai', 'sk-oai-xxx')
  assert.strictEqual(cfg.env.OPENAI_API_KEY, 'sk-oai-xxx')
  assert.strictEqual(cfg.agents.defaults.model.primary, 'openai/gpt-4o')
})

test('openai + baseUrl: 使用 models.providers', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'openai', 'sk-oai-xxx', { baseUrl: 'https://custom.openai.com' })
  assert.strictEqual(cfg.models.providers.openai.apiKey, 'sk-oai-xxx')
})

test('deepseek: 使用 models.providers.openai', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'deepseek', 'sk-ds-xxx')
  assert.strictEqual(cfg.models.providers.openai.baseUrl, 'https://api.deepseek.com')
  assert.strictEqual(cfg.agents.defaults.model.primary, 'openai/deepseek-chat')
})

test('qwen: 使用 DashScope 地址', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'qwen', 'sk-qw-xxx')
  assert.ok(cfg.models.providers.openai.baseUrl.includes('dashscope'))
})

test('glm: 设置 ZAI_API_KEY', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'glm', 'xxx.yyy')
  assert.strictEqual(cfg.env.ZAI_API_KEY, 'xxx.yyy')
})

test('volcengine: 默认 modelId', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'volcengine', 'sk-volc-xxx')
  assert.ok(cfg.agents.defaults.model.primary.includes('doubao'))
})

test('volcengine: 自定义 modelId', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'volcengine', 'sk-volc-xxx', { modelId: 'my-ep-123' })
  assert.strictEqual(cfg.agents.defaults.model.primary, 'openai/my-ep-123')
})

test('custom: 设置自定义 baseUrl 和 modelId', () => {
  const cfg = { env: {}, agents: {} }
  applyProviderConfig(cfg, 'custom', 'sk-xxx', { baseUrl: 'https://my.api.com', modelId: 'my-model' })
  assert.strictEqual(cfg.models.providers.openai.baseUrl, 'https://my.api.com')
  assert.strictEqual(cfg.agents.defaults.model.primary, 'openai/my-model')
})

test('unknown provider → 抛出错误', () => {
  const cfg = { env: {}, agents: {} }
  assert.throws(() => applyProviderConfig(cfg, 'unknown', 'key'), /未知/)
})

test('applyProviderConfig 不覆盖已有字段', () => {
  const cfg = { env: {}, agents: { defaults: { compaction: { mode: 'safeguard' }, maxConcurrent: 4 } } }
  applyProviderConfig(cfg, 'anthropic', 'key')
  assert.strictEqual(cfg.agents.defaults.compaction.mode, 'safeguard')
  assert.strictEqual(cfg.agents.defaults.maxConcurrent, 4)
})

test('buildOpenclawConfig 生成完整配置', () => {
  const config = buildOpenclawConfig({ aiProvider: 'deepseek', apiKey: 'sk-ds-test', chatTool: 'none' })
  assert.strictEqual(config.models.providers.openai.apiKey, 'sk-ds-test')
  assert.strictEqual(config.gateway.auth.mode, 'token')
  assert.strictEqual(config.gateway.mode, 'local')
  assert.strictEqual(config.update.checkOnStart, false)
})

test('buildOpenclawConfig 包含 tools.exec.host=gateway', () => {
  const config = buildOpenclawConfig({ aiProvider: 'deepseek', apiKey: 'test', chatTool: 'none' })
  assert.strictEqual(config.tools.exec.host, 'gateway')
  assert.strictEqual(config.tools.profile, 'full')
})

test('buildOpenclawConfig + telegram channel', () => {
  const config = buildOpenclawConfig({
    aiProvider: 'anthropic', apiKey: 'sk-ant-test',
    chatTool: 'telegram', chatConfig: { botToken: '123:abc' }
  })
  assert.strictEqual(config.channels.telegram.botToken, '123:abc')
  assert.strictEqual(config.plugins.entries.telegram.enabled, true)
})

// 清理
try { fs.unlinkSync(mockPathsFile) } catch {}

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`)
process.exit(failed > 0 ? 1 : 0)
