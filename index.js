import z from '@deepseek-ai/schemastery'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const Config = z.object({
  persona: z.string().default('你是一个认真的人，有礼貌，优雅，善于学习。'),
  provider: z.string().default(''),
  model: z.string().default(''),
  // session：orb 的消息直接进最新会话（共享人格/历史/工具）；direct：旧的直连问答。
  chatMode: z.string().default('session'),
  // orb 等待主会话回复的上限；超时只显示"已发送"。
  chatTimeoutMs: z.number().default(120000),
})

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))
const HELPER_DIR = join(PLUGIN_DIR, 'helper')

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function launchOrb(ctx) {
  try {
    const exe = join(dshHome(), 'electron', 'electron.exe')
    if (!existsSync(exe) || !existsSync(join(HELPER_DIR, 'main.js'))) return null
    const dir = join(dshHome(), 'desktop-orb')
    mkdirSync(dir, { recursive: true })
    const pidFile = join(dir, 'helper.pid')

    // The orb belongs to this host: stop a leftover from an earlier host so it
    // cannot outlive it, then start an instance bound to this host's pid.
    if (existsSync(pidFile)) {
      const oldPid = Number(readFileSync(pidFile, 'utf8').trim())
      if (oldPid && oldPid !== process.pid && pidAlive(oldPid)) {
        try { process.kill(oldPid) } catch {}
      }
    }

    const { ELECTRON_RUN_AS_NODE, ...env } = process.env
    const child = spawn(exe, [HELPER_DIR], {
      cwd: HELPER_DIR,
      env: { ...env, DSH_ORB_PARENT_PID: String(process.pid) },
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    if (child.pid) writeFileSync(pidFile, String(child.pid))
    return child
  } catch (err) {
    try { ctx.logger?.warn?.('[desktop-orb] launch:', err) } catch {}
    return null
  }
}

function readPersona() {
  try {
    const file = join(dshHome(), 'storages', 'evolving_persona.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const g = data.global || {}
    const tables = data.tables || {}
    const values = name => Object.values(tables[name] || {})
    const traits = values('traits')
      .filter(x => x && (x.status === 'active' || x.status === 'probation'))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 12)
    const patterns = values('patterns').sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 10)
    const styles = values('styles').sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 12)
    const observations = values('observations').sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 8)
    const events = values('events')
    return { self: g.self || '', traits, patterns, styles, observations, memories: events.map(e => e && e.text).filter(Boolean) }
  } catch (e) {
    return { self: '', traits: [], patterns: [], styles: [], observations: [], memories: [] }
  }
}

function buildSystem(config) {
  const { self, traits, patterns, styles, observations, memories } = readPersona()
  const base = config.persona || '你是一个认真的人，有礼貌，优雅，善于学习。'
  const lines = [`【人格底板（固定不变）】\n${base}`]
  if (self) lines.push(`【人格自述】\n${self}`)
  const active = traits.filter(t => t.status === 'active')
  const probation = traits.filter(t => t.status === 'probation')
  if (active.length) lines.push(`【已生效的成长特质】\n${active.map(t => '- ' + t.text).join('\n')}`)
  if (probation.length) lines.push(`【试用中的特质】\n${probation.map(t => '- ' + t.text).join('\n')}`)
  if (patterns.length) lines.push(`【关于用户的稳定认识】\n${patterns.map(p => '- ' + p.text).join('\n')}`)
  if (styles.length) lines.push(`【用户的用词与语气】\n${styles.map(s => '- ' + s.text).join('\n')}`)
  if (observations.length) lines.push(`【近期观察】\n${observations.map(o => '- ' + o.text).join('\n')}`)
  else if (memories.length) lines.push(`【重要记忆】\n${memories.slice(-20).map(m => '- ' + m).join('\n')}`)
  return lines.join('\n\n')
}

async function chat(ctx, config, text) {
  const llm = ctx.get('llm')
  if (!llm) return '（LLM 服务不可用）'
  let provider = config.provider
  let model = config.model
  if (!provider || !model) {
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
    provider = provider || sel?.provider
    model = model || sel?.model
  }
  if (!provider || !model) return '（未配置模型）'
  let out = ''
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      system: buildSystem(config),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 1000,
    })) {
      if (chunk.type === 'text-delta') out += chunk.text
    }
  } catch (err) {
    return '（调用出错：' + (err && err.message ? err.message : String(err)) + '）'
  }
  return out.trim() || '（空回复）'
}

/** 最近活跃的根 agent：orb 的"最后对话"。 */
function orbAgent(ctx) {
  const agents = ctx.get('agents')
  if (!agents) return null
  const list = typeof agents.roots === 'function' ? agents.roots() : agents.list()
  return Array.isArray(list) && list.length ? list[list.length - 1] : null
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * 把 orb 的一句话投进最新会话，等这一轮结束再取回复。
 * 消息带 source.kind='orb' 和"快问快答"前缀，让回复保持简短。
 */
async function chatViaSession(ctx, config, text) {
  const agent = orbAgent(ctx)
  if (!agent) return '没有正在运行的会话：先在 DSH 里打开一个对话。'

  const messageId = randomUUID()
  const sessionId = agent.id
  let last = ''
  let ours = false
  let dispose = () => {}

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { dispose() } catch {}
      resolve('')
    }, Math.max(10000, Number(config.chatTimeoutMs) || 120000))

    dispose = ctx.on('session/event', (session, event) => {
      if (!session || session.id !== sessionId) return
      // 当前轮结束（我们那条还没被认领）不算 orb 的回合。
      if (event.type === 'user/message') {
        if (event.data && event.data.id === messageId) ours = true
        return
      }
      if (!ours) return
      if (event.type === 'assistant/message') {
        const reply = textOfContent(event.data && event.data.message && event.data.message.content)
        if (reply) last = reply
      } else if (event.type === 'turn/end') {
        clearTimeout(timer)
        try { dispose() } catch {}
        resolve(last)
      }
    })
  })

  try {
    agent.followup({
      id: messageId,
      role: 'user',
      content: [{
        type: 'text',
        text: `[来自 orb · 快问快答：直接给结论，不展开推理]\n${text}`,
      }],
      source: { kind: 'orb' },
    })
  } catch (err) {
    try { dispose() } catch {}
    return '发送失败：' + (err && err.message ? err.message : String(err))
  }

  const reply = await done
  return reply || '已发送；这一轮比较久，回复会在窗口里继续显示。'
}

async function getBalance(ctx) {
  const acct = ctx.get('deepseekAccount')
  if (!acct) return '账户服务不可用'
  const client = {
    version: '1.0.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
  try {
    const bal = await acct.getBalance(client)
    if (!bal) return '未登录或凭证已变更'
    if (bal.status !== 'ready') return '余额查询失败'
    const fmt = w => {
      const n = Number(w.balance)
      if (!Number.isFinite(n) || Math.abs(n) < 1e-6) return null
      return (w.currency === 'CNY' ? '¥' : '$') + n.toFixed(2)
    }
    const parts = []
    for (const w of bal.value || []) { const s = fmt(w); if (s) parts.push(s) }
    for (const w of bal.bonusWallets || []) { const s = fmt(w); if (s) parts.push('赠送 ' + s) }
    return parts.join(' / ') || '余额为 0'
  } catch (err) {
    return '查询出错：' + (err && err.message ? err.message : String(err))
  }
}

export function apply(ctx, config) {
  let busy = false
  let orbBusy = false
  let orbChild = null
  ctx.on('agent/status', (payload) => {
    busy = !!(payload && payload.status === 'running')
  })

  ctx.effect(() => {
    const server = createServer(async (req, res) => {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
      if (req.method === 'GET' && req.url === '/balance') {
        const balanceText = await getBalance(ctx)
        res.writeHead(200, { ...cors, 'content-type': 'application/json' })
        res.end(JSON.stringify({ text: balanceText }))
        return
      }
      if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: (busy || orbBusy) ? 'running' : 'idle' }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/chat') { res.writeHead(404, cors); res.end('not found'); return }

      let body = ''
      for await (const chunk of req) body += chunk
      let text = ''
      try { text = (JSON.parse(body) || {}).text || '' } catch (e) {}
      const clean = String(text).trim()
      if (!clean) {
        res.writeHead(400, { ...cors, 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'empty text' }))
        return
      }

      try { ctx.get('personaMemory')?.rememberIfManual(clean) } catch (e) {}

      let reply
      if (config.chatMode === 'session') {
        reply = await chatViaSession(ctx, config, clean)
      } else {
        orbBusy = true
        try {
          reply = await chat(ctx, config, clean)
        } catch (err) {
          reply = '服务出错'
        } finally {
          orbBusy = false
        }
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      res.end(JSON.stringify({ reply }))
    })

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      try {
        const dir = join(dshHome(), 'desktop-orb')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'port.txt'), String(port))
      } catch (e) {}
      orbChild = launchOrb(ctx)
    })

    return () => {
      try { server.close() } catch (e) {}
      try { if (orbChild && orbChild.pid) process.kill(orbChild.pid) } catch (e) {}
    }
  })
}
