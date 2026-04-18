const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  openUI:              ()       => ipcRenderer.invoke('pet-open-ui'),
  setIgnoreMouseEvents:(ignore) => ipcRenderer.send('pet-ignore-mouse', ignore),
  onStatusUpdate:      (cb)     => {
    ipcRenderer.removeAllListeners('pet-status')
    ipcRenderer.on('pet-status', (_, s) => cb(s))
  }
})
