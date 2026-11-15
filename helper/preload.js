const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('orb', {
  moveBy: (dx, dy) => ipcRenderer.send('orb:moveBy', dx, dy),
  dragStart: () => ipcRenderer.send('orb:dragStart'),
  dragMove: () => ipcRenderer.send('orb:dragMove'),
  dragEnd: () => ipcRenderer.send('orb:dragEnd'),
  setExpanded: (expanded) => ipcRenderer.invoke('orb:setExpanded', expanded),
  setBubble: (show) => ipcRenderer.invoke('orb:setBubble', show),
  showPoem: (text) => ipcRenderer.invoke('orb:showPoem', text),
  savePosition: () => ipcRenderer.send('orb:savePosition'),
  hover: (inside) => ipcRenderer.send('orb:hover', inside),
  chat: (text) => ipcRenderer.invoke('orb:chat', text),
  contextMenu: () => ipcRenderer.send('orb:contextMenu'),
  onOpen: (cb) => {
    const h = () => cb()
    ipcRenderer.on('orb:open', h)
    return () => ipcRenderer.removeListener('orb:open', h)
  },
  onBalance: (cb) => {
    const h = (e, v) => cb(v)
    ipcRenderer.on('orb:balance', h)
    return () => ipcRenderer.removeListener('orb:balance', h)
  },
  onPoem: (cb) => {
    const h = () => cb()
    ipcRenderer.on('orb:poem', h)
    return () => ipcRenderer.removeListener('orb:poem', h)
  },
  onStatus: (cb) => {
    const h = (e, v) => cb(v)
    ipcRenderer.on('orb:status', h)
    return () => ipcRenderer.removeListener('orb:status', h)
  },
  onTalk: (cb) => {
    const h = (e, v) => cb(v)
    ipcRenderer.on('orb:talk', h)
    return () => ipcRenderer.removeListener('orb:talk', h)
  },
  transcribe: (payload) => ipcRenderer.invoke('orb:transcribe', payload),
})
