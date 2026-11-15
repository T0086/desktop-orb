const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CONFIG_PATH = path.join(__dirname, 'config.json')
const BALL = 76
const PANEL_W = 380
const PANEL_H = 460
const BUBBLE_W = 240
const BUBBLE_H = 136
// 练字纸：960 宽。高度按最长的一首（七律 56 字、8 句）留够——
// 30px 字 + 2 倍行距约 480px，加标题作者和间距约 560，取 640 留余量。
const POEM_W = 960
const POEM_H = 640
// 贴边隐藏：离屏幕边缘 EDGE_SNAP 内算"贴上"，缩进去只露 PEEK 宽。
const EDGE_SNAP = 10
const PEEK = 26

function writePidFile() {
  try {
    const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'desktop-orb')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'helper.pid'), String(process.pid))
  } catch (e) {}
}
writePidFile()

// The launcher passes the DSH host pid: quit as soon as that host is gone, so
// the orb never outlives the app it belongs to (even on a hard kill).
const PARENT_PID = Number(process.env.DSH_ORB_PARENT_PID || 0)
if (PARENT_PID) {
  const timer = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch (e) {
      clearInterval(timer)
      app.quit()
    }
  }, 3000)
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (e) { return {} }
}

function writeConfig(patch) {
  try {
    const next = { ...readConfig(), ...patch }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2))
  } catch (e) {}
}

let win = null
let snapEdge = null   // 当前贴的是哪条边：left / right / top / bottom
let hoverTimer = null
let animTimer = null
let dragStart = null      // 拖动起点：{ cursor, win }
let menuOpen = false       // 右键菜单开着的时候不要缩回去
let hoverLocked = false    // 缩回去后锁住 hover，等鼠标真的离开过窗口一次再解锁
let hoverPending = false   // 锁定期间鼠标进来过，解锁时补一次弹出

// 只用主屏。
// 副屏方案弃用了：两块屏 DPI 不同时，光标坐标、窗口坐标、setPosition 三家换算
// 对不齐，拖动会飘、会弹、会拉不动，修了几轮都不值当。现在球永远留在主屏内。
function workAreaNear() {
  return screen.getPrimaryDisplay().workArea
}

// 跨屏 / 混合 DPI 时 setPosition 会抛 conversion failure，一抛就是主进程
// Uncaught Exception（会弹框、整个球崩掉）。所以所有移动统一走这里。
function safeSetPosition(x, y) {
  if (!win) return
  const nx = Math.round(Number(x))
  const ny = Math.round(Number(y))
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
  try {
    win.setPosition(nx, ny)
  } catch (err) {
    console.warn('[orb] setPosition failed:', nx, ny, err && err.message)
  }
}

function clamp(x, y, w, h) {
  const d = workAreaNear(x, y)
  return {
    x: Math.min(Math.max(d.x, x), d.x + d.width - w),
    y: Math.min(Math.max(d.y, y), d.y + d.height - h),
    width: w,
    height: h,
  }
}

// DIP 与物理像素互转：两块屏缩放比例不同时，光标 DIP 和窗口 DIP 不一定是同一套
// 换算基准，直接减会漂。放到物理像素上算差值最稳；API 不存在时原样返回。
function toPhys(pt) {
  try {
    return screen.dipToScreenPoint ? screen.dipToScreenPoint(pt) : pt
  } catch {
    return pt
  }
}

function toDip(pt) {
  try {
    return screen.screenToDipPoint ? screen.screenToDipPoint(pt) : pt
  } catch {
    return pt
  }
}

function edgeOf(x, y) {
  const d = workAreaNear(x, y)
  if (x <= d.x + EDGE_SNAP) return 'left'
  if (x + BALL >= d.x + d.width - EDGE_SNAP) return 'right'
  if (y <= d.y + EDGE_SNAP) return 'top'
  if (y + BALL >= d.y + d.height - EDGE_SNAP) return 'bottom'
  return null
}

function hiddenPosition(edge, x, y) {
  const d = workAreaNear(x, y)
  switch (edge) {
    case 'left': return { x: d.x - BALL + PEEK, y }
    case 'right': return { x: d.x + d.width - PEEK, y }
    case 'top': return { x, y: d.y - BALL + PEEK }
    case 'bottom': return { x, y: d.y + d.height - PEEK }
  }
  return { x, y }
}

// 逐帧补间：窗口位置没有原生动画，只能自己算。easeOutCubic 起步快、收尾稳，
// 看起来像被"吸"过去，而不是硬跳。
function animateTo(tx, ty, duration = 200) {
  if (!win) return
  const txN = Number(tx)
  const tyN = Number(ty)
  if (!Number.isFinite(txN) || !Number.isFinite(tyN)) return
  tx = txN
  ty = tyN
  if (animTimer) { clearInterval(animTimer); animTimer = null }
  const [sx, sy] = win.getPosition()
  const dx = Math.round(tx) - sx
  const dy = Math.round(ty) - sy
  if (dx === 0 && dy === 0) return
  if (duration <= 0) { safeSetPosition(Math.round(tx), Math.round(ty)); return }
  const start = Date.now()
  animTimer = setInterval(() => {
    if (!win) { clearInterval(animTimer); animTimer = null; return }
    const t = Math.min(1, (Date.now() - start) / duration)
    const e = 1 - Math.pow(1 - t, 3)
    safeSetPosition(Math.round(sx + dx * e), Math.round(sy + dy * e))
    if (t >= 1) {
      safeSetPosition(Math.round(tx), Math.round(ty))
      clearInterval(animTimer)
      animTimer = null
    }
  }, 16)
}

// 贴边时"完整露出来"该在的位置
function edgeRestPos(edge, x, y) {
  const d = workAreaNear(x, y)
  let nx = x
  let ny = y
  if (edge === 'left') nx = d.x
  else if (edge === 'right') nx = d.x + d.width - BALL
  else if (edge === 'top') ny = d.y
  else if (edge === 'bottom') ny = d.y + d.height - BALL
  return { x: nx, y: ny }
}

function peekIn(duration = 220) {
  if (!win || !snapEdge) return
  const [x, y] = win.getPosition()
  const p = hiddenPosition(snapEdge, x, y)
  animateTo(p.x, p.y, duration)
  // 缩回去之后鼠标多半还压在露出的那一条上。这里不按时间屏蔽——按时间会吞掉
  // 这期间产生的 mouseenter，而鼠标不动就不会再发第二次，结果永远唤不出。
  // 改成"锁住"，等它真的离开过窗口一次才解锁。
  hoverLocked = true
  hoverPending = false
}

function peekOut(duration = 140) {
  if (!win || !snapEdge) return
  const [x, y] = win.getPosition()
  const p = edgeRestPos(snapEdge, x, y)
  animateTo(p.x, p.y, duration)
}

function createWindow() {
  const cfg = readConfig()
  const d = screen.getPrimaryDisplay().workArea
  const pos = cfg.position && typeof cfg.position.x === 'number'
    ? clamp(cfg.position.x, cfg.position.y, BALL, BALL)
    : clamp(d.x + d.width - BALL - 24, d.y + d.height - BALL - 24, BALL, BALL)

  win = new BrowserWindow({
    ...pos,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,   // 永不抢焦点：打游戏时鼠标滑过、点击都不切走前台
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'index.html'))
  win.on('closed', () => { win = null })
}

ipcMain.on('orb:moveBy', (event, dx, dy) => {
  if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return
  // 拖动优先：打断在跑的动画，并且无动画地把窗口拽回完整位置
  if (animTimer) { clearInterval(animTimer); animTimer = null }
  if (snapEdge) {
    const [cx, cy] = win.getPosition()
    const r = edgeRestPos(snapEdge, cx, cy)
    safeSetPosition(Math.round(r.x), Math.round(r.y))
    snapEdge = null
  }
  const [x, y] = win.getPosition()
  const size = win.getSize()
  const next = clamp(x + Math.round(dx), y + Math.round(dy), size[0], size[1])
  safeSetPosition(next.x, next.y)
})

/**
 * 拖动改成主进程主导：renderer 只报告"开始/移动/结束"，位置由这里用
 * screen.getCursorScreenPoint() 的绝对坐标算。
 *
 * 原因：renderer 的 e.screenX 是 DIP，两块屏 DPI 不同时，跨屏换算会失真 ——
 * 表现为拖动范围变小、拖不回原来的屏。光标坐标和 setPosition 用同一套坐标，
 * 跨屏才是一致的。
 */
ipcMain.on('orb:dragStart', () => {
  if (!win) return
  if (animTimer) { clearInterval(animTimer); animTimer = null }
  // 按下的瞬间不要再把窗口挪到"完整位置"：唤出动画还没跑完时这么一跳，
  // 视觉上就是"点住往下弹"。直接以当前位置为起点开始拖，位置交给拖动本身。
  snapEdge = null
  hoverLocked = false
  hoverPending = false
  const cursor = screen.getCursorScreenPoint()
  const wp = win.getPosition()
  dragStart = {
    cursor,
    win: wp,
    cursorPhys: toPhys(cursor),
    winPhys: toPhys({ x: wp[0], y: wp[1] }),
    lastCursor: cursor,
    lastMoveAt: 0,
  }
})

ipcMain.on('orb:dragMove', () => {
  if (!win || !dragStart) return
  const cur = screen.getCursorScreenPoint()
  // 窗口自己移动也会触发 pointermove（鼠标其实没动）。不去重的话就是
  // 移动→事件→再移动的反馈环，副屏 DPI 不同时它不收敛，表现就是"按住就飘"。
  if (cur.x === dragStart.lastCursor.x && cur.y === dragStart.lastCursor.y) return
  const now = Date.now()
  if (now - dragStart.lastMoveAt < 12) return
  dragStart.lastMoveAt = now
  // 增量式：每帧只移动"这一帧光标走了多少"，基准是窗口的真实位置。
  // 绝对定位会把一次换算误差整份兑现成跳动；增量式每帧重新对齐，不会积累。
  // ⚠ lastCursor 只能在算出 dx 之后更新 —— 先更新的话 dx 恒为 0，球就拉不动了。
  const dx = cur.x - dragStart.lastCursor.x
  const dy = cur.y - dragStart.lastCursor.y
  dragStart.lastCursor = cur
  const [wx, wy] = win.getPosition()
  // 拖动过程中也夹在主屏范围内：往副屏方向拖，球会停在主屏边缘，不会跟过去。
  const c = clamp(wx + dx, wy + dy, BALL, BALL)
  safeSetPosition(c.x, c.y)
})

ipcMain.on('orb:dragEnd', () => {
  if (!win) return
  dragStart = null
  const [x, y] = win.getPosition()
  const c = clamp(x, y, BALL, BALL)
  if (c.x !== x || c.y !== y) safeSetPosition(c.x, c.y)
  writeConfig({ position: { x: c.x, y: c.y } })
  snapEdge = edgeOf(c.x, c.y)
  if (snapEdge) peekIn()
})

ipcMain.handle('orb:setExpanded', (event, expanded) => {
  snapEdge = null
  if (!win) return false
  const [x, y] = win.getPosition()
  const size = win.getSize()
  if (expanded) {
    win.setBounds(clamp(x + size[0] - PANEL_W, y + size[1] - PANEL_H, PANEL_W, PANEL_H))
  } else {
    win.setBounds(clamp(x + size[0] - BALL, y + size[1] - BALL, BALL, BALL))
  }
  return true
})

ipcMain.handle('orb:setBubble', (event, show) => {
  if (!win) return false
  const [x, y] = win.getPosition()
  const size = win.getSize()
  if (show) {
    win.setBounds(clamp(x + size[0] - BUBBLE_W, y + size[1] - BUBBLE_H, BUBBLE_W, BUBBLE_H))
  } else {
    win.setBounds(clamp(x + size[0] - BALL, y + size[1] - BALL, BALL, BALL))
  }
  return true
})

/**
 * 练字纸是**独立窗口**，不和球共用一个窗口。
 *
 * 之前把纸放进球窗口里，拖纸 = 拖窗口 = 球跟着跑。拆成两个窗口之后，
 * 纸可以随便摆，球钉在原地不动，还能把纸拖到另一块显示器上。
 */
let poemWin = null

function ensurePoemWindow() {
  if (poemWin && !poemWin.isDestroyed()) return poemWin
  const d = screen.getPrimaryDisplay().workArea
  const w = Math.min(POEM_W, d.width - 40)
  const h = Math.min(POEM_H, d.height - 40)
  poemWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(d.x + (d.width - w) / 2),
    y: Math.round(d.y + (d.height - h) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,   // 永不抢焦点：打游戏时鼠标滑过、点击都不切走前台
    webPreferences: {
      preload: path.join(__dirname, 'poem-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  poemWin.setAlwaysOnTop(true, 'screen-saver')
  poemWin.loadFile(path.join(__dirname, 'poem.html'))
  poemWin.on('closed', () => { poemWin = null })
  return poemWin
}

ipcMain.handle('orb:showPoem', (event, text) => {
  const w = ensurePoemWindow()
  const send = () => { try { w.webContents.send('poem:text', String(text || '')) } catch (e) {} }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
  w.show()
  return true
})

ipcMain.on('poem:close', () => {
  try { if (poemWin && !poemWin.isDestroyed()) poemWin.close() } catch (e) {}
})

ipcMain.on('poem:moveBy', (event, dx, dy) => {
  if (!poemWin || poemWin.isDestroyed()) return
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  const [x, y] = poemWin.getPosition()
  const [w, h] = poemWin.getSize()
  const next = clamp(Math.round(x + dx), Math.round(y + dy), w, h)
  poemWin.setPosition(next.x, next.y)
})

ipcMain.on('orb:savePosition', () => {
  if (!win) return
  const [x, y] = win.getPosition()
  writeConfig({ position: { x, y } })
  // 松手时判定贴边：贴上了就缩进去，只露一条边
  snapEdge = edgeOf(x, y)
  if (snapEdge) peekIn()
})

// 悬停唤出 / 移开收回。mouseenter 不冒泡，由渲染进程在 body 上转发。
ipcMain.on('orb:hover', (event, inside) => {
  if (!win || !snapEdge) return
  if (inside) {
    if (hoverLocked) { hoverPending = true; return }
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
    peekOut()
    return
  }
  // 鼠标离开窗口：解锁。如果锁定期间进来过，直接补一次弹出，不再等
  hoverLocked = false
  if (hoverPending) { hoverPending = false; peekOut(); return }
  if (menuOpen) return
  if (hoverTimer) return
  hoverTimer = setTimeout(() => {
    hoverTimer = null
    if (!snapEdge || menuOpen) return
    // 窗口弹出来之后鼠标可能还在里面，用系统光标位置复核，避免缩回/弹出抖动
    const p = screen.getCursorScreenPoint()
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return
    peekIn()
  }, 380)
})

function readPort() {
  try {
    const file = path.join(os.homedir(), '.dsh', 'desktop-orb', 'port.txt')
    const n = parseInt(fs.readFileSync(file, 'utf8'), 10)
    return Number.isFinite(n) ? n : 0
  } catch (e) {
    return 0
  }
}

ipcMain.handle('orb:chat', async (event, text) => {
  const port = readPort()
  if (!port) return '（助手服务未就绪：请确认 desktop-orb 插件已安装并运行）'
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: String(text || '') }),
    })
    const data = await res.json()
    return (data && data.reply) || '（无回复）'
  } catch (err) {
    return '（连接失败：' + (err && err.message ? err.message : String(err)) + '）'
  }
})

async function fetchBalanceText() {
  const port = readPort()
  if (!port) return '（助手服务未就绪）'
  try {
    const res = await fetch(`http://127.0.0.1:${port}/balance`)
    const data = await res.json()
    return (data && data.text) || '（无余额数据）'
  } catch (err) {
    return '（连接失败：' + (err && err.message ? err.message : String(err)) + '）'
  }
}

ipcMain.on('orb:contextMenu', () => {
  if (!win) return
  menuOpen = true
  const menu = Menu.buildFromTemplate([
    {
      label: '显示余额',
      click: async () => {
        const text = await fetchBalanceText()
        if (win) win.webContents.send('orb:balance', text)
      },
    },
    {
      label: '练字',
      click: () => { if (win) win.webContents.send('orb:poem') },
    },
    {
      label: '打开对话',
      click: () => { if (win) win.webContents.send('orb:open') },
    },
    { type: 'separator' },
    {
      label: '取消贴边',
      click: () => {
        if (!win) return
        const [x, y] = win.getPosition()
        const r = snapEdge ? edgeRestPos(snapEdge, x, y) : { x, y }
        snapEdge = null
        hoverLocked = false
        hoverPending = false
        animateTo(r.x, r.y, 160)
        writeConfig({ position: { x: r.x, y: r.y } })
      },
    },
    { label: '退出', click: () => app.quit() },
  ])
  menu.popup({
    window: win,
    callback: () => {
      menuOpen = false
      // 菜单关掉之后要补一次缩回判定：鼠标移到菜单上时发的那次 mouseleave
      // 被 menuOpen 拦掉了（菜单开着窗口不能跑），而鼠标已经在窗口外，
      // 不会再有第二次 leave —— 不补的话球就永远露在外面。
      setTimeout(() => {
        if (!win || !snapEdge) return
        const p = screen.getCursorScreenPoint()
        const [x, y] = win.getPosition()
        const [w, h] = win.getSize()
        if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return
        peekIn()
      }, 150)
    },
  })
})

let lastStatus = null
async function pollStatus() {
  if (!win) return
  const port = readPort()
  if (!port) return
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    const data = await res.json()
    const running = !!(data && data.status === 'running')
    if (running !== lastStatus) {
      lastStatus = running
      if (win) win.webContents.send('orb:status', running)
    }
  } catch (e) {}
}
setInterval(pollStatus, 500)

// ---- 全局语音键：右 Alt 点一下再按住 ----
// 这里必须用系统级键状态（koffi + GetAsyncKeyState），因为页面不在前台时
// 浏览器收不到 keydown。DSH 自带 koffi，直接按绝对路径加载。
function readVoicePort() {
  try {
    const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'voice-talk', 'port.txt')
    const n = parseInt(fs.readFileSync(file, 'utf8'), 10)
    return Number.isFinite(n) ? n : 0
  } catch (e) { return 0 }
}

ipcMain.handle('orb:transcribe', async (event, payload) => {
  const port = readVoicePort()
  if (!port) return { error: '语音服务未就绪' }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    })
    return await res.json()
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) }
  }
})

let GetAsyncKeyState = null
try {
  const koffi = require('D:/DeepSeek/resources/app.asar.unpacked/dsh/node_modules/koffi')
  const user32 = koffi.load('user32.dll')
  GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)')
} catch (e) {
  console.error('[orb] koffi unavailable:', e.message)
}

const VK_RMENU = 0xa5
const TAP_MAX_MS = 300
const TAP_GAP_MS = 400
let altDown = false
let tapCount = 0
let lastUpAt = 0
let pressAt = 0
let mixed = false
let holdTimer = null
let holding = false

function othersDown() {
  if (!GetAsyncKeyState) return false
  return [0x11, 0x10, 0x5b, 0x5c].some(vk => (GetAsyncKeyState(vk) & 0x8000) !== 0)
}

function sendTalk(kind) {
  if (win) win.webContents.send('orb:talk', kind)
}

function pollTalkKey() {
  if (!GetAsyncKeyState) return
  const down = (GetAsyncKeyState(VK_RMENU) & 0x8000) !== 0
  if (down === altDown) return
  altDown = down
  const now = Date.now()
  if (down) {
    if (tapCount === 1 && now - lastUpAt > TAP_GAP_MS) tapCount = 0
    if (tapCount === 0) {
      pressAt = now
      mixed = othersDown()
      return
    }
    holdTimer = setTimeout(() => {
      holdTimer = null
      if (!altDown) { sendTalk('cancel'); return }
      holding = true
      sendTalk('start')
    }, TAP_MAX_MS)
    // 按下瞬间就预热麦克风：getUserMedia 的启动延迟被 300ms 判定窗口吸收，
    // 判定成立后 renderer 把这段缓冲并入正式录音，开口第一个字不丢。
    sendTalk('warm')
    return
  }
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; sendTalk('cancel'); return }
  if (holding) {
    holding = false
    tapCount = 0
    sendTalk('stop')
    return
  }
  if (tapCount === 0) {
    if (!mixed && now - pressAt <= TAP_MAX_MS) { tapCount = 1; lastUpAt = now }
    else tapCount = 0
  }
}

if (GetAsyncKeyState) setInterval(pollTalkKey, 40)

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
