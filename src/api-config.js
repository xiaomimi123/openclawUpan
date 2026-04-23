/**
 * V5 中转站 API 常量
 * 对接 https://aitoken.homes —— 业务接口走 /api/*，AI 代理走 /v1/*
 */

const API_HOST = 'https://aitoken.homes'
const AI_PROXY_PREFIX = '/v1'

const ENDPOINTS = {
  // 认证
  SEND_CODE:        '/api/auth/send-code',
  REGISTER:         '/api/auth/register',
  LOGIN:            '/api/auth/login',
  REFRESH:          '/api/auth/refresh',
  LOGOUT:           '/api/auth/logout',

  // 用户 / 用量
  USER_PROFILE:     '/api/user/profile',
  USER_BALANCE:     '/api/user/balance',
  BILLING_USAGE:    '/api/billing/usage',

  // 充值
  TOPUP_PACKAGES:   '/api/topup/packages',
  TOPUP_CREATE:     '/api/topup/create-order',
  TOPUP_ORDER:      (orderId) => `/api/topup/order/${encodeURIComponent(orderId)}`,

  // 模型
  MODELS_LIST:      '/api/models/list',
  MODELS_KEY:       '/api/models/api-key',
  MODELS_KEY_RESET: '/api/models/api-key/reset',
}

const TIMEOUTS = {
  DEFAULT: 15000,
  SHORT:    5000,
  LONG:    30000,
}

// 充值订单轮询参数
const TOPUP_POLL = {
  INTERVAL_MS: 2000,
  TIMEOUT_MS:  10 * 60 * 1000,
}

module.exports = {
  API_HOST,
  AI_PROXY_PREFIX,
  ENDPOINTS,
  TIMEOUTS,
  TOPUP_POLL,
}
