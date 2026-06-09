// WebSocket client for streaming agent sessions and chat tails

import WebSocket from 'ws'
import { getHubUrl, getHubToken } from './client.js'

function getWsUrl(): string {
  const httpUrl = getHubUrl()
  return httpUrl.replace(/^http/, 'ws')
}

function buildWsOptions(): WebSocket.ClientOptions {
  const opts: WebSocket.ClientOptions = { rejectUnauthorized: false }
  const token = getHubToken()
  if (token) opts.headers = { Authorization: `Bearer ${token}` }
  return opts
}

export async function connectAndStream(opts: {
  filter: (msg: unknown) => boolean
  onMessage: (msg: unknown) => void | 'stop'
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl(), buildWsOptions())

    ws.on('open', () => {
      // Connection established — messages will flow
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (opts.filter(msg)) {
          const result = opts.onMessage(msg)
          if (result === 'stop') {
            ws.close()
            resolve()
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    })

    ws.on('close', () => resolve())
    ws.on('error', (err) => reject(err))
  })
}

/**
 * Open one socket, send an initial message, then stream — letting the handler
 * push further messages mid-stream via `send`. Used by `con agent chat`, which
 * must fork a session, then (once the fork is created) inject a prompt, then
 * wait for the reply — all on a single connection.
 *
 * The handler returns 'stop' to finish. Resolves on stop, socket close, or
 * timeout.
 */
export async function streamWithSends(opts: {
  initial: unknown
  onMessage: (msg: any, send: (m: unknown) => void) => void | 'stop'
  timeoutMs?: number
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl(), buildWsOptions())
    const send = (m: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }
    const timer = setTimeout(() => { ws.close(); resolve() }, timeoutMs)
    ws.on('open', () => send(opts.initial))
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (opts.onMessage(msg, send) === 'stop') { clearTimeout(timer); ws.close(); resolve() }
      } catch { /* ignore */ }
    })
    ws.on('close', () => { clearTimeout(timer); resolve() })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * Inject a message into an existing session and return its reply text.
 *
 * Critical subtlety: on connect the hub REPLAYS each session's recent message
 * log (including the previous turn's `text` + `result`). If we sent immediately
 * and watched for `result`, we'd capture the OLD turn's reply. So we first wait
 * for the replay burst to go quiet (no message for `settleMs`), THEN send, THEN
 * capture only the live turn. Live assistant text arrives as `text_delta`
 * (deltas are never logged/replayed), which also helps distinguish live output.
 */
export async function injectAndCapture(opts: {
  sessionId: string
  message: string
  timeoutMs?: number
  settleMs?: number
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const settleMs = opts.settleMs ?? 500
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl(), buildWsOptions())
    const deltas: string[] = []
    const texts: string[] = []
    let sent = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const hardTimer = setTimeout(() => finish(), timeoutMs)

    const finish = () => {
      clearTimeout(hardTimer)
      if (settleTimer) clearTimeout(settleTimer)
      try { ws.close() } catch { /* noop */ }
      resolve(texts.join('\n').trim() || deltas.join('').trim())
    }

    const armSettle = () => {
      if (sent) return
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        // Replay has gone quiet — now it's safe to drive a fresh turn.
        sent = true
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'send_message', sessionId: opts.sessionId, content: opts.message }))
        }
      }, settleMs)
    }

    ws.on('open', armSettle)
    ws.on('message', (data) => {
      let msg: any
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (!sent) { armSettle(); return } // still draining replay
      if (msg.sessionId !== opts.sessionId) return
      if (msg.type === 'text_delta') deltas.push(msg.content || '')
      else if (msg.type === 'text') texts.push(msg.content || '')
      else if (msg.type === 'result' || msg.type === 'session_ended') finish()
    })
    ws.on('close', () => { clearTimeout(hardTimer); if (settleTimer) clearTimeout(settleTimer); resolve(texts.join('\n').trim() || deltas.join('').trim()) })
    ws.on('error', (err) => { clearTimeout(hardTimer); reject(err) })
  })
}

export async function sendAndReceive(
  message: unknown,
  matchResponse: (msg: unknown) => boolean,
  timeoutMs = 10000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl(), buildWsOptions())
    let timer: ReturnType<typeof setTimeout>

    ws.on('open', () => {
      ws.send(JSON.stringify(message))

      // If we don't need a response, resolve immediately
      if (matchResponse === (() => false)) {
        setTimeout(() => {
          ws.close()
          resolve(null)
        }, 100)
        return
      }

      timer = setTimeout(() => {
        ws.close()
        resolve(null)
      }, timeoutMs)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (matchResponse(msg)) {
          clearTimeout(timer)
          ws.close()
          resolve(msg)
        }
      } catch {
        // Ignore
      }
    })

    ws.on('close', () => {
      clearTimeout(timer)
      resolve(null)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
