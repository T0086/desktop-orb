const paper = document.getElementById('paper')
const content = document.getElementById('content')
const closeBtn = document.getElementById('close')

/**
 * 约定文本三段：第 1 行诗题、第 2 行作者、其余每句一行正文。
 * 分三层排，因为字号和字重都不一样，整段塞一起就糊了。
 */
function renderPoem(text) {
  content.replaceChildren()
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean)
  if (!lines.length) {
    const d = document.createElement('div')
    d.className = 'poem-body'
    d.textContent = '（没拿到诗）'
    content.appendChild(d)
    return
  }

  const title = document.createElement('div')
  title.className = 'poem-title'
  title.textContent = lines[0]
  content.appendChild(title)

  if (lines.length >= 2) {
    const author = document.createElement('div')
    author.className = 'poem-author'
    author.textContent = lines[1]
    content.appendChild(author)
  }

  const body = document.createElement('div')
  body.className = 'poem-body'
  for (const line of lines.slice(2)) {
    const d = document.createElement('div')
    d.textContent = line
    body.appendChild(d)
  }
  content.appendChild(body)
}

window.poem.onText(renderPoem)

closeBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  window.poem.close()
})

// 拖整张纸：这个窗口是独立的，所以拖动它不会带动球。
let dragging = false
let lastX = 0
let lastY = 0

paper.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  if (e.target.closest('#close')) return
  dragging = true
  lastX = e.screenX
  lastY = e.screenY
  paper.classList.add('dragging')
  try { paper.setPointerCapture(e.pointerId) } catch (err) {}
})

paper.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const dx = e.screenX - lastX
  const dy = e.screenY - lastY
  lastX = e.screenX
  lastY = e.screenY
  if (dx || dy) window.poem.moveBy(dx, dy)
})

paper.addEventListener('pointerup', (e) => {
  if (!dragging) return
  dragging = false
  paper.classList.remove('dragging')
  try { paper.releasePointerCapture(e.pointerId) } catch (err) {}
})
