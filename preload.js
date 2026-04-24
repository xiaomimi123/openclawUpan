const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('usb', {
  // Window
  minimize: ()       => ipcRenderer.send('window-minimize'),
  close:    ()       => ipcRenderer.send('window-close'),
  navigate: (page)   => ipcRenderer.invoke('navigate', page),

  // Setup
  getSetupStatus: ()      => ipcRenderer.invoke('get-setup-status'),
  saveSetup:      (data)  => ipcRenderer.invoke('save-setup', data),

  // Openclaw
  startOpenclaw:    ()    => ipcRenderer.invoke('start-openclaw'),
  stopOpenclaw:     ()    => ipcRenderer.invoke('stop-openclaw'),
  getOpenclawStatus: ()   => ipcRenderer.invoke('get-openclaw-status'),
  repairConfig:     ()    => ipcRenderer.invoke('repair-config'),
  preflightCheck:   ()    => ipcRenderer.invoke('preflight-check'),
  killPort:         (port) => ipcRenderer.invoke('kill-port', port),

  // Config
  updateApiKey: (key, provider, opts) => ipcRenderer.invoke('update-api-key', { key, provider, ...opts }),
  validateApiKey: (key, provider, baseUrl) => ipcRenderer.invoke('validate-api-key', { key, provider, baseUrl }),
  getVersion:   ()    => ipcRenderer.invoke('get-version'),

  // 技能商店
  checkSkillInstalled:     (id) => ipcRenderer.invoke('check-skill-installed', id),
  installSkill:            (npm) => ipcRenderer.invoke('install-skill', npm),
  installFeishuPlugin:     ()   => ipcRenderer.invoke('install-feishu-plugin'),

  // Pet
  showPet: () => ipcRenderer.invoke('show-pet'),
  hidePet: () => ipcRenderer.invoke('hide-pet'),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openUiWindow:  ()    => ipcRenderer.invoke('open-ui-window'),
  openSkillStore: ()   => ipcRenderer.invoke('open-skill-store'),
  openHelpCenter: ()   => ipcRenderer.invoke('open-help-center'),

  // Events
  onUsbRemoved: (cb) => {
    ipcRenderer.removeAllListeners('usb-removed')
    ipcRenderer.on('usb-removed', cb)
  },
  onOpenclawLog:   (cb) => {
    ipcRenderer.removeAllListeners('openclaw-log')
    ipcRenderer.on('openclaw-log', (_, msg) => cb(msg))
  },
  onOpenclawStopped: (cb) => {
    ipcRenderer.removeAllListeners('openclaw-stopped')
    ipcRenderer.on('openclaw-stopped', (_, code) => cb(code))
  },
  onNetworkRetry: (cb) => {
    ipcRenderer.removeAllListeners('openclaw-network-retry')
    ipcRenderer.on('openclaw-network-retry', () => cb())
  },
  onAutoRestart: (cb) => {
    ipcRenderer.removeAllListeners('openclaw-auto-restart')
    ipcRenderer.on('openclaw-auto-restart', () => cb())
  }
})

// ─── V5：登录/注册/token 管理（独立命名空间 window.auth）─────────────────
contextBridge.exposeInMainWorld('auth', {
  sendCode:    (email)     => ipcRenderer.invoke('auth:send-code', email),
  register:    (payload)   => ipcRenderer.invoke('auth:register', payload),
  login:       (payload)   => ipcRenderer.invoke('auth:login', payload),
  logout:      ()          => ipcRenderer.invoke('auth:logout'),
  isLoggedIn:  ()          => ipcRenderer.invoke('auth:is-logged-in'),
  getUser:     ()          => ipcRenderer.invoke('auth:get-user'),
  refreshUser: ()          => ipcRenderer.invoke('auth:refresh-user'),
  reload:      ()          => ipcRenderer.invoke('auth:reload'),

  // token 彻底失效时触发，UI 应跳回登录页
  onAuthFailed: (cb) => {
    ipcRenderer.removeAllListeners('auth:failed')
    ipcRenderer.on('auth:failed', () => cb())
  },
})

// ─── V5：主窗口生命周期控制 ────────────────────────────────────────────
contextBridge.exposeInMainWorld('mainWin', {
  // 退出登录：调后端 logout + 清 auth.json + 关主窗 + 开登录窗
  logout:            () => ipcRenderer.invoke('main-win:logout'),
  // 仅切换窗口，不调 auth 后端（用于 session 失效自救）
  transitionToLogin: () => ipcRenderer.send('main-win:transition-to-login'),
  // session 失效事件订阅
  onAuthFailed: (cb) => {
    ipcRenderer.removeAllListeners('auth:failed')
    ipcRenderer.on('auth:failed', () => cb())
  },
})

// ─── V5：模型配置（官方 token 管理 + 上架模型目录）─────────────────────
contextBridge.exposeInMainWorld('models', {
  // 拉已有 token，为空时自动创建一个
  listOrCreateToken: () => ipcRenderer.invoke('token:list-or-create'),
  // 重置 token（删旧 + 建新）
  resetToken:        () => ipcRenderer.invoke('token:reset'),
  // 官方上架的模型目录（公开接口）
  listOfficial:      () => ipcRenderer.invoke('models:list-official'),
})

// ─── V5：充值（灵境AI 聚合支付） ────────────────────────────────────────
contextBridge.exposeInMainWorld('topup', {
  listPlans:    ()             => ipcRenderer.invoke('topup:list-plans'),
  payConfig:    ()             => ipcRenderer.invoke('topup:pay-config'),
  createOrder:  (payload)      => ipcRenderer.invoke('topup:create-order', payload),
  orderStatus:  (orderNo)      => ipcRenderer.invoke('topup:order-status', orderNo),
  redeem:       (key)          => ipcRenderer.invoke('topup:redeem', key),
})

// ─── V5：技能管理 ────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('skills', {
  list: () => ipcRenderer.invoke('skills:list'),
})

// ─── V5：联系客服 ────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('support', {
  config: () => ipcRenderer.invoke('support:config'),
})
