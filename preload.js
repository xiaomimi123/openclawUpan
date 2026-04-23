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
