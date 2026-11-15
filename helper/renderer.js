const ball = document.getElementById('ball')
const panel = document.getElementById('panel')
const log = document.getElementById('log')
const text = document.getElementById('text')
const status = document.getElementById('status')
const sendBtn = document.getElementById('send')
const closeBtn = document.getElementById('close')
const bubble = document.getElementById('bubble')

let open = false
let dragging = false
let moved = 0
let lastX = 0
let lastY = 0

function setOpen(next) {
  open = next
  panel.classList.toggle('open', open)
  window.orb.setExpanded(open)
  if (open) setTimeout(() => text.focus(), 60)
}

function append(role, content) {
  const div = document.createElement('div')
  div.className = 'msg ' + role
  div.textContent = content
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
}

let bubbleTimer = null
function showBubble(content) {
  // 先把面板真正收起来（窗口尺寸也要变回球）。只改 DOM 不够：主进程那边窗口
  // 还是 380×460，气泡会按面板的矩形定位，飘到离球很远的地方，收起后球还会
  // 被挪到别处。IPC 是顺序处理的，先收面板再弹气泡，位置才对。
  if (open) {
    open = false
    panel.classList.remove('open')
    void window.orb.setExpanded(false)
  }
  bubble.textContent = content
  bubble.style.display = 'block'
  window.orb.setBubble(true)
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    bubble.style.display = 'none'
    window.orb.setBubble(false)
  }, 3500)
}

ball.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  ball.setPointerCapture(e.pointerId)
  dragging = true
  moved = 0
  lastX = e.screenX
  lastY = e.screenY
  window.orb.dragStart()
})

ball.addEventListener('pointermove', (e) => {
  if (!dragging) return
  moved += Math.abs(e.screenX - lastX) + Math.abs(e.screenY - lastY)
  lastX = e.screenX
  lastY = e.screenY
  // 位置交给主进程按光标绝对坐标算：e.screenX 是 DIP，两块屏 DPI 不同时
  // 跨屏换算会失真，拿它算位移会表现为「拖动范围变小、拖不回原来的屏」。
  window.orb.dragMove()
})

ball.addEventListener('pointerup', (e) => {
  if (!dragging) return
  dragging = false
  try { ball.releasePointerCapture(e.pointerId) } catch (err) {}
  window.orb.dragEnd()
  if (moved < 4) setOpen(!open)
})

ball.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.orb.contextMenu()
})

// 贴边缩进去之后，鼠标进窗口就滑出来，移开再缩回去（收回的判定在主进程，
// 那边会用系统光标位置复核，避免缩回/弹出反复抖动）。
document.body.addEventListener('mouseenter', () => window.orb.hover(true))
document.body.addEventListener('mouseleave', () => window.orb.hover(false))

window.orb.onOpen(() => setOpen(true))
window.orb.onBalance((text) => {
  showBubble('💰 ' + text)
})
window.orb.onStatus((running) => {
  const thinking = !!running
  ball.classList.toggle('thinking', thinking)
  if (thinking) startHueDrift()
  else resetHue()
})

// 思考越久，颜色越偏：深蓝 → 青 → 紫。每 1.8s 转 7°，约 72s 到顶。
let hueTimer = null
let hueValue = 0
function startHueDrift() {
  if (hueTimer) return
  hueTimer = setInterval(() => {
    hueValue = Math.min(280, hueValue + 7)
    ball.style.setProperty('--orb-hue', hueValue + 'deg')
    if (hueValue >= 280) { clearInterval(hueTimer); hueTimer = null }
  }, 1800)
}
function resetHue() {
  if (hueTimer) { clearInterval(hueTimer); hueTimer = null }
  hueValue = 0
  ball.style.setProperty('--orb-hue', '0deg')
}

closeBtn.addEventListener('click', () => setOpen(false))

/**
 * 统一发一条消息：输入框的「发送」和「练字」快捷按钮走同一条通道。
 * 之前只有发送按钮，逻辑直接写在监听器里；加第二个入口时抽出来，
 * 免得两边各写一份、以后改一处漏一处。
 */
let asking = false
async function ask(message) {
  if (asking) return
  asking = true
  append('user', message)
  sendBtn.disabled = true
  status.textContent = '思考中…'
  try {
    const reply = await window.orb.chat(message)
    append('assistant', reply)
  } catch (err) {
    append('assistant', '（出错：' + (err && err.message ? err.message : String(err)) + '）')
  } finally {
    status.textContent = ''
    sendBtn.disabled = false
    asking = false
  }
}

sendBtn.addEventListener('click', () => {
  const t = text.value.trim()
  if (!t) return
  text.value = ''
  void ask(t)
})

/**
 * 右键菜单「练字」：拉一首诗，交给独立的纸窗口显示。
 *
 * 纸是另一个 BrowserWindow，所以拖它不会带动球。这里只负责拿内容，
 * 排版和拖动都在 poem.js 里。
 */
async function requestPoem() {
  if (open) setOpen(false)
  void window.orb.showPoem('选一首…')
  try {
    const reply = await window.orb.chat(
      '推荐今天练字的诗。只输出：第一行诗题，第二行作者，空一行，然后正文每句一行。' +
      '不要任何说明、赏析、序号、引号。用简体中文。'
    )
    void window.orb.showPoem(reply)
  } catch (err) {
    void window.orb.showPoem('出错\n' + (err && err.message ? err.message : String(err)))
  }
}

window.orb.onPoem(() => { void requestPoem() })

text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendBtn.click()
  }
})

// ---- 全局语音键录音（主进程轮询右 Alt，这里只负责录音与转写）----
const LANG = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
let talk = null
let talkChunks = []
// 预热：第二次按下瞬间开流采集，300ms 判定成立后把缓冲并入正式录音。
let warm = null
let warmPromise = null
let warmToken = 0

function resample(input, from, to) {
  if (from === to || !input.length) return input
  const ratio = from / to
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = pos - i0
    out[i] = input[i0] * (1 - t) + input[i1] * t
  }
  return out
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const str = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function warmTalk() {
  if (warm || warmPromise) return warmPromise
  const token = ++warmToken
  warmPromise = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const AC = window.AudioContext || window.webkitAudioContext
      const audioCtx = new AC()
      if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {})
      const source = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1)
      const chunks = []
      processor.onaudioprocess = (e) => {
        if (warm) warm.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(audioCtx.destination)
      if (token !== warmToken) {
        try { processor.disconnect() } catch (e) {}
        try { source.disconnect() } catch (e) {}
        try { stream.getTracks().forEach(x => x.stop()) } catch (e) {}
        try { await audioCtx.close() } catch (e) {}
        return
      }
      warm = { stream, audioCtx, source, processor, chunks, sampleRate: audioCtx.sampleRate }
    } catch (err) {
      showBubble('麦克风打不开：' + (err && err.message ? err.message : String(err)))
    } finally {
      warmPromise = null
    }
  })()
  return warmPromise
}

function releaseWarm() {
  warmToken += 1 // 让在途的 warmTalk 完成后直接丢弃
  const w = warm
  warm = null
  if (!w) return
  try { w.processor.disconnect() } catch (e) {}
  try { w.source.disconnect() } catch (e) {}
  try { w.stream.getTracks().forEach(x => x.stop()) } catch (e) {}
  try { w.audioCtx.close() } catch (e) {}
}

async function startTalk() {
  if (talk) return
  await warmTalk()
  const w = warm
  if (!w) return
  warm = null
  talkChunks = w.chunks // 已包含按下→判定之间的缓冲
  w.processor.onaudioprocess = (e) => {
    if (talk) talkChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  talk = { stream: w.stream, audioCtx: w.audioCtx, source: w.source, processor: w.processor, sampleRate: w.sampleRate }
  showBubble('🎙 录音中…')
}

async function stopTalk() {
  // 预热流还没转成正式录音就收到 stop：直接丢弃预热，避免麦克风残留。
  if (!talk) { releaseWarm(); return }
  const t = talk
  talk = null
  try { t.processor.disconnect() } catch (e) {}
  try { t.source.disconnect() } catch (e) {}
  try { t.stream.getTracks().forEach(x => x.stop()) } catch (e) {}
  try { await t.audioCtx.close() } catch (e) {}

  const total = talkChunks.reduce((n, c) => n + c.length, 0)
  const chunks = talkChunks
  talkChunks = []
  if (total < 1600) { showBubble('太短了'); return }

  const merged = new Float32Array(total)
  let at = 0
  for (const c of chunks) { merged.set(c, at); at += c.length }
  const wav = encodeWav(resample(merged, t.sampleRate, 16000), 16000)
  showBubble('转写中…')
  const res = await window.orb.transcribe({ audioBase64: toBase64(wav), language: LANG })
  if (res && res.text) showBubble(res.text)
  else showBubble('转写失败：' + (res && res.error ? res.error : '没识别到'))
}

window.orb.onTalk((kind) => {
  if (kind === 'warm') void warmTalk()
  else if (kind === 'start') void startTalk()
  else if (kind === 'cancel') releaseWarm()
  else void stopTalk()
})
