/**
 * V5 中转站 API 常量（灵镜AI / new-api 后端）
 * Base: https://aitoken.homes
 *
 * 鉴权机制：
 *   - /api/user/*、/api/token/*、/api/lingjing/* 等业务路由 → Cookie session（登录返回 Set-Cookie）
 *   - /v1/* AI 代理 + /v1/dashboard/* 余额 → Bearer sk-xxx（API Token，一个账号可创建多个）
 *
 * 响应格式统一：{ success: boolean, message: string, data: any }，HTTP 永远 200
 */

const API_HOST = 'https://aitoken.homes'

const ENDPOINTS = {
  // ─── 用户认证（Cookie session） ─────────────────────────────────────────
  SEND_CODE:    '/api/verification',      // GET ?email=xxx  （60s 限频）
  REGISTER:     '/api/user/register',     // POST {username,email,password,password2,verification_code}
  LOGIN:        '/api/user/login',        // POST {username,password} → Set-Cookie: session=xxx
  LOGOUT:       '/api/user/logout',       // GET（带 cookie）
  USER_SELF:    '/api/user/self',         // GET（带 cookie） → 用户 profile

  // ─── API Token 管理（Cookie session） ──────────────────────────────────
  TOKEN_LIST:   '/api/token/',                     // GET  列令牌
  TOKEN_CREATE: '/api/token/',                     // POST 创建
  TOKEN_DELETE: (id) => `/api/token/${id}`,        // DELETE

  // ─── 公开配置 ──────────────────────────────────────────────────────────
  LINGJING_CONFIG:    '/api/lingjing/config',      // 站点配置（客服、邮箱验证开关等）
  LINGJING_PLANS:     '/api/lingjing/plans',       // 套餐列表
  LINGJING_MODEL_PRICES: '/api/lingjing/model-prices', // 模型广场价格
  LINGJING_PAY_CONFIG: '/api/lingjing/pay/config', // 支付状态（alipay/wxpay 是否开通）
  STATUS:             '/api/status',               // 健康检查

  // ─── 余额 / 用量（Bearer sk-xxx） ──────────────────────────────────────
  BILLING_SUB:   '/v1/dashboard/billing/subscription',
  BILLING_USAGE: '/v1/dashboard/billing/usage',

  // ─── AI 代理（Bearer sk-xxx） ──────────────────────────────────────────
  V1_CHAT:       '/v1/chat/completions',
  V1_MODELS:     '/v1/models',
}

const TIMEOUTS = {
  DEFAULT: 15000,
  SHORT:    5000,
  LONG:    30000,
}

module.exports = {
  API_HOST,
  ENDPOINTS,
  TIMEOUTS,
}
