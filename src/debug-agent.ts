// Debug agent — streams console, network, and errors to the hub for Claude Code observability
// Must be imported FIRST in main.tsx (before React, stores, anything) to capture all events.

interface DebugEvent {
  ts: number
  cat: 'console' | 'net' | 'error' | 'perf'
  level?: string
  args?: string[]
  method?: string
  url?: string
  status?: number
  duration?: number
  reqBody?: string
  resBody?: string
  message?: string
  stack?: string
  filename?: string
  lineno?: number
  colno?: number
}

interface DebugCommand {
  type: string
  id?: string
  code?: string
  stores?: string[]
  enabled?: boolean
}

const MAX_BODY_LEN = 2048
const FLUSH_INTERVAL = 200
const MAX_BUFFER = 50
const RECONNECT_DELAY = 3000

// Preserve originals before patching
const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _error = console.error.bind(console)
const _info = console.info.bind(console)
const _debug = console.debug.bind(console)
const _fetch = window.fetch.bind(window)

let ws: WebSocket | null = null
let buffer: DebugEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let enabled = true
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// --------------------------------------------------------------------------
// WS connection
// --------------------------------------------------------------------------

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host || 'localhost'
  // Same-origin /hub/debug — Caddy strips /hub before forwarding to the
  // hub's WS endpoint. Off-host PWA / dev pages on :5173 fall through to
  // the historic :9877 path via the explicit port substitution.
  if (window.location.port === '5173') {
    return `${proto}//${window.location.hostname || 'localhost'}:9877/debug`
  }
  return `${proto}//${host}/hub/debug`
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  try {
    ws = new WebSocket(getWsUrl())

    ws.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      flush() // Send buffered events
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as DebugCommand
        handleCommand(msg)
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      ws = null
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  } catch {
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, RECONNECT_DELAY)
}

function send(event: DebugEvent): void {
  if (!enabled) return
  buffer.push(event)
  if (buffer.length >= MAX_BUFFER) {
    // Drop oldest, add marker
    buffer = buffer.slice(-MAX_BUFFER)
  }
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL)
  }
}

function flush(): void {
  flushTimer = null
  if (buffer.length === 0) return
  if (!ws || ws.readyState !== WebSocket.OPEN) return

  try {
    ws.send(JSON.stringify({ type: 'debug_events', events: buffer }))
    buffer = []
  } catch {
    // Will retry next flush
  }
}

function sendDirect(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// --------------------------------------------------------------------------
// Console hooks
// --------------------------------------------------------------------------

function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function installConsoleHooks(): void {
  const hook = (level: string, orig: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      orig(...args)
      send({
        ts: Date.now(),
        cat: 'console',
        level,
        args: args.map(stringify),
      })
    }
  }

  console.log = hook('log', _log)
  console.warn = hook('warn', _warn)
  console.error = hook('error', _error)
  console.info = hook('info', _info)
  console.debug = hook('debug', _debug)
}

// --------------------------------------------------------------------------
// Fetch hooks
// --------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `... [${s.length} chars]` : s
}

function installFetchHooks(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method || 'GET'
    const start = performance.now()

    // Don't capture debug WS or debug API calls (infinite loop)
    if (url.includes('/debug')) {
      return _fetch(input, init)
    }

    let reqBody: string | undefined
    if (init?.body && typeof init.body === 'string') {
      reqBody = truncate(init.body, MAX_BODY_LEN)
    }

    try {
      const res = await _fetch(input, init)
      const duration = Math.round(performance.now() - start)

      // Clone response to read body without consuming
      let resBody: string | undefined
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('json') || contentType.includes('text')) {
        try {
          const clone = res.clone()
          const text = await clone.text()
          resBody = truncate(text, MAX_BODY_LEN)
        } catch { /* can't read body */ }
      }

      send({
        ts: Date.now(),
        cat: 'net',
        method,
        url: truncate(url, 500),
        status: res.status,
        duration,
        reqBody,
        resBody,
      })

      return res
    } catch (err) {
      const duration = Math.round(performance.now() - start)
      send({
        ts: Date.now(),
        cat: 'net',
        method,
        url: truncate(url, 500),
        status: 0,
        duration,
        reqBody,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

// --------------------------------------------------------------------------
// Error hooks
// --------------------------------------------------------------------------

function installErrorHooks(): void {
  window.addEventListener('error', (e) => {
    send({
      ts: Date.now(),
      cat: 'error',
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error?.stack,
    })
  })

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    send({
      ts: Date.now(),
      cat: 'error',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  })

  // Drain early errors buffered before this module loaded
  const early = (window as any).__earlyErrors as Array<{ type: string; message?: string; reason?: string; filename?: string; lineno?: number; colno?: number; ts: number }> | undefined
  if (early) {
    for (const e of early) {
      send({
        ts: e.ts,
        cat: 'error',
        message: e.message || e.reason || 'Unknown error',
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
      })
    }
    ;(window as any).__earlyErrors = undefined
  }
}

// --------------------------------------------------------------------------
// RPC command handler
// --------------------------------------------------------------------------

async function handleCommand(msg: DebugCommand): Promise<void> {
  switch (msg.type) {
    case 'debug_eval': {
      try {
        // eslint-disable-next-line no-eval
        const result = await Promise.resolve(eval(msg.code!))
        sendDirect({
          type: 'debug_eval_result',
          id: msg.id,
          result: stringify(result),
        })
      } catch (err) {
        sendDirect({
          type: 'debug_eval_result',
          id: msg.id,
          result: '',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      break
    }

    case 'debug_get_state': {
      const stores: Record<string, unknown> = {}
      const __console = (window as any).__console
      if (__console?.stores) {
        const requested = msg.stores || Object.keys(__console.stores)
        for (const name of requested) {
          const store = __console.stores[name]
          if (store?.getState) {
            try {
              const state = store.getState()
              // Serialize, stripping functions
              stores[name] = JSON.parse(JSON.stringify(state, (_, v) =>
                typeof v === 'function' ? undefined : v
              ))
            } catch { /* skip */ }
          }
        }
      }
      sendDirect({ type: 'debug_state', id: msg.id, stores })
      break
    }

    case 'debug_screenshot': {
      try {
        // html2canvas is optional — install with `npm i html2canvas` for screenshot support
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = await (Function('return import("html2canvas")')() as Promise<any>)
        const html2canvas = mod.default || mod
        const canvas = await html2canvas(document.documentElement, {
          scale: 1,
          logging: false,
          useCORS: true,
        })
        sendDirect({
          type: 'debug_screenshot',
          id: msg.id,
          dataUrl: canvas.toDataURL('image/png'),
        })
      } catch (err) {
        sendDirect({
          type: 'debug_screenshot',
          id: msg.id,
          dataUrl: '',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      break
    }

    case 'debug_toggle':
      enabled = msg.enabled ?? true
      break
  }
}

// --------------------------------------------------------------------------
// Initialize on import (browser only — skip in Node/test environments)
// --------------------------------------------------------------------------

if (typeof window !== 'undefined' && typeof WebSocket !== 'undefined') {
  installConsoleHooks()
  installFetchHooks()
  installErrorHooks()
  connect()
}
