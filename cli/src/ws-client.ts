// WebSocket client for streaming agent sessions and chat tails

import WebSocket from 'ws'
import { getHubUrl, getHubToken } from './client.js'
import { ReplyCapture, type StreamMsg } from './reply-capture.js'

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
 * On connect the hub REPLAYS each session's recent message log, including the
 * previous turn's `text` + `result`. We wait for the burst to go quiet before
 * sending, but quiet is not proof it is over, so the capture also drops every
 * message logged before the send (`fromIndex` = the session's log length).
 */
export async function injectAndCapture(opts: {
  sessionId: string
  message: string
  fromIndex: number
  timeoutMs?: number
  settleMs?: number
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const settleMs = opts.settleMs ?? 500
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl(), buildWsOptions())
    let seenUpTo = -1
    let capture: ReplyCapture | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const hardTimer = setTimeout(() => finish(), timeoutMs)
    const reply = () => capture?.reply ?? ''

    const finish = () => {
      clearTimeout(hardTimer)
      if (settleTimer) clearTimeout(settleTimer)
      try { ws.close() } catch { /* noop */ }
      resolve(reply())
    }

    const armSettle = () => {
      if (capture) return
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        capture = new ReplyCapture(opts.sessionId, Math.max(opts.fromIndex, seenUpTo + 1))
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'send_message', sessionId: opts.sessionId, content: opts.message }))
        }
      }, settleMs)
    }

    ws.on('open', armSettle)
    ws.on('message', (data) => {
      let msg: StreamMsg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (!capture) {
        if (msg.sessionId === opts.sessionId && typeof msg.absIndex === 'number') seenUpTo = Math.max(seenUpTo, msg.absIndex)
        armSettle()
        return
      }
      if (capture.take(msg)) finish()
    })
    ws.on('close', () => { clearTimeout(hardTimer); if (settleTimer) clearTimeout(settleTimer); resolve(reply()) })
    ws.on('error', (err) => { clearTimeout(hardTimer); reject(err) })
  })
}

/** Pass as `matchResponse` for fire-and-forget sends: resolves ~100ms after the
 *  message is flushed (the hub has it), without waiting for a reply. */
export const NO_RESPONSE = () => false

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

      // If we don't need a response, resolve shortly after the send is flushed
      if (matchResponse === NO_RESPONSE) {
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
