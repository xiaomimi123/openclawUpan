/**
 * 配置构建模块（USB 钥匙版，精简）
 * openclaw 原生运行，不需要配置自愈/归拢/路径修复
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { configDir, installDir } = require('./paths')
const APP_VERSION = require('../package.json').version

// ─── 基础模型条目 ─────────────────────────────────────────────────────────

function baseModelEntry(id, name) {
  return {
    id, name,
    api: 'openai-completions',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192
  }
}

// ─── 统一 Provider 配置 ──────────────────────────────────────────────────

/**
 * 将指定服务商的 API Key 配置写入 cfg 对象
 * @param {object} cfg - openclaw.json 配置对象（会被原地修改）
 * @param {string} provider - 服务商标识
 * @param {string} key - API Key
 * @param {object} opts - 额外选项 { baseUrl, modelId, modelName }
 */
function applyProviderConfig(cfg, provider, key, opts = {}) {
  if (!cfg.env) cfg.env = {}
  if (!cfg.agents) cfg.agents = {}
  if (!cfg.agents.defaults) cfg.agents.defaults = {}

  switch (provider) {
    case 'anthropic':
      cfg.env.ANTHROPIC_API_KEY = key
      if (opts.baseUrl) cfg.env.ANTHROPIC_BASE_URL = opts.baseUrl
      cfg.agents.defaults.model = { primary: 'anthropic/claude-sonnet-4-6' }
      break

    case 'openai':
      if (opts.baseUrl) {
        if (!cfg.models) cfg.models = {}
        if (!cfg.models.providers) cfg.models.providers = {}
        cfg.models.providers.openai = {
          apiKey: key,
          baseUrl: opts.baseUrl,
          models: [baseModelEntry('gpt-4o', 'GPT-4o')]
        }
      } else {
        cfg.env.OPENAI_API_KEY = key
      }
      cfg.agents.defaults.model = { primary: 'openai/gpt-4o' }
      break

    case 'deepseek':
      if (!cfg.models) cfg.models = {}
      if (!cfg.models.providers) cfg.models.providers = {}
      cfg.models.providers.openai = {
        apiKey: key,
        baseUrl: 'https://api.deepseek.com',
        models: [baseModelEntry('deepseek-chat', 'DeepSeek Chat')]
      }
      cfg.agents.defaults.model = { primary: 'openai/deepseek-chat' }
      break

    case 'qwen':
      if (!cfg.models) cfg.models = {}
      if (!cfg.models.providers) cfg.models.providers = {}
      cfg.models.providers.openai = {
        apiKey: key,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        models: [baseModelEntry('qwen-max', '通义千问 Max')]
      }
      cfg.agents.defaults.model = { primary: 'openai/qwen-max' }
      break

    case 'glm':
      cfg.env.ZAI_API_KEY = key
      cfg.agents.defaults.model = { primary: 'zai/glm-4-plus' }
      break

    case 'volcengine': {
      const volcModelId = opts.modelId || 'doubao-seed-2-0-pro-260215'
      if (!cfg.models) cfg.models = {}
      if (!cfg.models.providers) cfg.models.providers = {}
      cfg.models.providers.openai = {
        apiKey: key,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        models: [baseModelEntry(volcModelId, '豆包')]
      }
      cfg.agents.defaults.model = { primary: 'openai/' + volcModelId }
      break
    }

    case 'custom': {
      if (!cfg.models) cfg.models = {}
      if (!cfg.models.providers) cfg.models.providers = {}
      cfg.models.providers.openai = {
        apiKey: key,
        baseUrl: opts.baseUrl,
        models: [baseModelEntry(opts.modelId || 'custom-model', opts.modelName || '自定义模型')]
      }
      cfg.agents.defaults.model = { primary: 'openai/' + (opts.modelId || 'custom-model') }
      break
    }

    default:
      throw new Error('未知的 AI 服务商: ' + provider)
  }
}

// ─── 构建完整配置（首次设置时使用）─────────────────────────────────────────

function buildOpenclawConfig(setup) {
  const config = {
    meta: {
      lastTouchedVersion: APP_VERSION,
      lastTouchedAt: new Date().toISOString()
    },
    wizard: {
      lastRunAt: new Date().toISOString(),
      lastRunVersion: APP_VERSION,
      lastRunCommand: 'configure',
      lastRunMode: 'local'
    },
    env: {},
    agents: {
      defaults: {
        workspace: path.join(installDir, 'workspace'),
        model: { primary: '' },
        compaction: { mode: 'safeguard' },
        maxConcurrent: 4,
        subagents: { maxConcurrent: 8 },
      }
    },
    channels: {},
    gateway: {
      mode: 'local',
      auth: {
        mode: 'token',
        token: crypto.randomBytes(24).toString('hex')
      },
      controlUi: {
        allowInsecureAuth: true,
        dangerouslyDisableDeviceAuth: true
      }
    },
    plugins: {
      entries: {},
      allow: []
    },
    tools: {
      profile: 'full',
      exec: {
        host: 'gateway',
        security: 'full',
      }
    },
    commands: { native: 'auto', nativeSkills: 'auto', restart: true, ownerDisplay: 'raw' },
    update: { checkOnStart: false }
  }

  // AI provider
  applyProviderConfig(config, setup.aiProvider, setup.apiKey, {
    baseUrl: setup.baseUrl,
    modelId: setup.customModelId,
    modelName: setup.customModelName
  })

  // Chat channel
  switch (setup.chatTool) {
    case 'telegram':
      config.channels.telegram = {
        enabled: true,
        botToken: setup.chatConfig.botToken,
        dmPolicy: 'pairing',
        groupPolicy: 'allowlist',
        streaming: 'partial'
      }
      config.plugins.entries.telegram = { enabled: true }
      break

    case 'discord':
      config.channels.discord = {
        enabled: true,
        token: setup.chatConfig.token
      }
      config.plugins.entries.discord = { enabled: true }
      break

    case 'feishu':
      config.channels.feishu = {
        enabled: true,
        appId: setup.chatConfig.appId,
        appSecret: setup.chatConfig.appSecret,
      }
      break

    case 'none':
    default:
      break
  }

  return config
}

// ─── 刷新 gateway token（每次启动时调用）────────────────────────────────

async function refreshGatewayToken() {
  const configPath = path.join(configDir, 'openclaw.json')
  if (!fs.existsSync(configPath)) return null
  try {
    const token = crypto.randomBytes(24).toString('hex')
    const cfg = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
    // 只刷新 token；auth mode、controlUi 等用户可能手动调过，缺失时才兜底
    if (!cfg.gateway) cfg.gateway = {}
    if (!cfg.gateway.mode) cfg.gateway.mode = 'local'
    if (!cfg.gateway.auth) cfg.gateway.auth = { mode: 'token' }
    cfg.gateway.auth.token = token
    if (!cfg.gateway.controlUi) {
      cfg.gateway.controlUi = { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: true }
    }
    await fs.promises.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
    return token
  } catch (e) {
    console.error('[refreshGatewayToken] failed:', e.message)
    return null
  }
}

/**
 * 将新配置与已有配置合并：启动器只覆盖自己管理的字段，保留用户自行配置的内容
 * @param {object} newConfig - buildOpenclawConfig 生成的新配置
 * @param {object|null} existing - 已有的 openclaw.json 配置（如果存在）
 * @returns {object} 合并后的配置
 */
function mergeUserConfig(newConfig, existing) {
  if (!existing) return newConfig

  // 启动器只管这些顶层 key，其余全部保留用户/插件写入的
  const LAUNCHER_OWNED_KEYS = new Set([
    'meta', 'wizard', 'env', 'agents', 'channels', 'gateway', 'plugins',
    'tools', 'commands', 'update', 'models'
  ])

  // 1. 先把旧配置中启动器不管的顶层字段全部搬过来（插件自定义的字段）
  for (const key of Object.keys(existing)) {
    if (!LAUNCHER_OWNED_KEYS.has(key)) {
      newConfig[key] = existing[key]
    }
  }

  // 2. 保留用户已有的 agents（自定义 agent 配置等），但覆盖 defaults
  if (existing.agents) {
    for (const key of Object.keys(existing.agents)) {
      if (key !== 'defaults') newConfig.agents[key] = existing.agents[key]
    }
  }

  // 3. 保留用户已有的 channels（启动器未配置的 channel）
  if (existing.channels) {
    for (const key of Object.keys(existing.channels)) {
      if (!(key in newConfig.channels)) newConfig.channels[key] = existing.channels[key]
    }
  }

  // 4. 保留用户已有的 plugins（启动器未配置的 plugin）
  if (existing.plugins?.entries) {
    for (const key of Object.keys(existing.plugins.entries)) {
      if (!(key in newConfig.plugins.entries)) newConfig.plugins.entries[key] = existing.plugins.entries[key]
    }
  }
  // 保留用户已有的 plugins.allow 白名单
  if (existing.plugins?.allow) {
    newConfig.plugins.allow = existing.plugins.allow
  }
  // 保留 plugins.installs（openclaw 管理的安装元数据，启动器不动）
  if (existing.plugins?.installs) {
    newConfig.plugins.installs = existing.plugins.installs
  }

  // 5. 保留用户/插件添加的 env 变量（启动器只管 AI 相关的 env key）
  if (existing.env) {
    const AI_ENV_KEYS = new Set([
      'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
      'OPENAI_API_KEY', 'ZAI_API_KEY'
    ])
    for (const key of Object.keys(existing.env)) {
      if (!AI_ENV_KEYS.has(key) && !(key in newConfig.env)) {
        newConfig.env[key] = existing.env[key]
      }
    }
  }

  // 6. 保留用户/插件添加的 tools 子字段
  if (existing.tools) {
    for (const key of Object.keys(existing.tools)) {
      if (!(key in newConfig.tools)) newConfig.tools[key] = existing.tools[key]
    }
  }

  // 7. 保留用户/插件添加的 commands 子字段
  if (existing.commands) {
    for (const key of Object.keys(existing.commands)) {
      if (!(key in newConfig.commands)) newConfig.commands[key] = existing.commands[key]
    }
  }

  return newConfig
}

module.exports = {
  baseModelEntry,
  applyProviderConfig,
  buildOpenclawConfig,
  mergeUserConfig,
  refreshGatewayToken
}
