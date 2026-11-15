const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('poem', {
  onText: (cb) => {
    const h = (e, v) => cb(v)
    ipcRenderer.on('poem:text', h)
    return () => ipcRenderer.removeListener('poem:text', h)
  },
  moveBy: (dx, dy) => ipcRenderer.send('poem:moveBy', dx, dy),
  close: () => ipcRenderer.send('poem:close'),
})
