/**
 * 登录窗专用 preload
 * 只暴露登录/注册所需最小接口，不泄露主窗口的 window.usb
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('auth', {
  sendCode:   (email)   => ipcRenderer.invoke('auth:send-code', email),
  register:   (payload) => ipcRenderer.invoke('auth:register', payload),
  login:      (payload) => ipcRenderer.invoke('auth:login', payload),
  isLoggedIn: ()        => ipcRenderer.invoke('auth:is-logged-in'),
})

contextBridge.exposeInMainWorld('loginWin', {
  minimize:         () => ipcRenderer.send('login-win:minimize'),
  close:            () => ipcRenderer.send('login-win:close'),
  transitionToMain: () => ipcRenderer.send('login-win:transition-to-main'),
  openExternal:     (url) => ipcRenderer.invoke('open-external', url),
})
