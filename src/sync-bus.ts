// ============================================================================
// Hub Sync Bus — browser-side counterpart to server/src/sync-bus.ts.
//
// Single WebSocket to /sync carries:
//   • Subscriptions to service event streams (mail, calendar, matrix, prefs…)
//   • RPC calls that the hub handles authoritatively (send mail, create event…)
//
// Used by service "observers" on the browser: they subscribe to events and
// reconcile them into their local Dexie cache / Zustand store.
//
// Auto-reconnects with exponential backoff. Pending RPCs re-send after
// reconnect; subscriptions are re-established automatically.
// ============================================================================

import { getHubWsUrl } from './hub'

type Handler = (data: unknown) => void
type Pending = {
  service: string
  op: string
  args: unknown
  resolve: (v: unknown) => void
  reject: (err: Error) => void
  timeoutHandle?: ReturnType<typeof setTimeout>
}

export interface RpcOptions {
  /** Reject with `Error('hub timeout')` after this many ms. Without it the
   *  promise hangs until the hub eventually responds (or forever). */
  timeoutMs?: number
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000

export class HubSyncBus {
  private ws: WebSocket | null = null
  private subs = new Map<string, Set<Handler>>() // key: `${service}.${op}` or `${service}.*`
  private subscribedServices = new Set<string>() // services we've told the hub about
  private pending = new Map<string | number, Pending>()
  private nextId = 1
  private reconnectDelayMs = 500
  private readonly MAX_RECONNECT_MS = 30_000
  private stopped = false
  private connectCount = 0
  private connectHandlers = new Set<(info: { first: boolean }) => void>()
  private disconnectHandlers = new Set<() => void>()

  connect(): void {
    this.stopped = false
    this.open()
  }

  close(): void {
    this.stopped = true
    try { this.ws?.close() } catch {}
    this.ws = null
  }

  /** Listen for events of shape {service, op, data}. Returns unsubscribe fn. */
  on(service: string, op: string, handler: Handler): () => void {
    const key = `${service}.${op}`
    let set = this.subs.get(key)
    if (!set) { set = new Set(); this.subs.set(key, set) }
    set.add(handler)
    this.ensureSubscribed(service)
    return () => {
      set!.delete(handler)
      if (set!.size === 0) this.subs.delete(key)
      // Keep the service subscribed even if one specific op has no listeners —
      // other ops for the same service may still want events. Unsub only when
      // every handler for the service is gone:
      const still = Array.from(this.subs.keys()).some((k) => k.startsWith(service + '.'))
      if (!still) {
        this.subscribedServices.delete(service)
        this.sendRaw({ t: 'unsub', service })
      }
    }
  }

  /** Call an RPC op. Rejects on transport error, hub-returned {ok:false}, or
   *  on timeout if `opts.timeoutMs` is set (defaults to 30 s). */
  rpc<T = unknown>(service: string, op: string, args?: unknown, opts?: RpcOptions): Promise<T> {
    const id = this.nextId++
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        service, op, args,
        resolve: (v) => resolve(v as T),
        reject,
      }
      if (timeoutMs > 0) {
        entry.timeoutHandle = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error('hub timeout'))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      this.trySend({ t: 'rpc', id, service, op, args })
    })
  }

  /** True once the WebSocket has successfully opened at least once. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Subscribe to WS-open events. Fires on every successful connect, including
   * reconnects after a drop. `info.first === true` on the very first open of
   * this bus instance — useful to differentiate cold-start boot from a
   * recovery after the APK was backgrounded / the laptop went to sleep.
   *
   * Callers should use this to trigger catch-up RPCs (e.g. matrix `snapshot`)
   * since the hub doesn't buffer missed deltas for disconnected clients.
   */
  onConnect(handler: (info: { first: boolean }) => void): () => void {
    this.connectHandlers.add(handler)
    return () => { this.connectHandlers.delete(handler) }
  }

  /** Fires once per actual transition from connected→disconnected. Won't fire
   *  during the initial connect attempt before `onopen` ever ran. */
  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => { this.disconnectHandlers.delete(handler) }
  }

  // ---- internals ----

  private ensureSubscribed(service: string): void {
    if (this.subscribedServices.has(service)) return
    this.subscribedServices.add(service)
    this.sendRaw({ t: 'sub', service })
  }

  private sendRaw(msg: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    try { this.ws.send(JSON.stringify(msg)); return true } catch { return false }
  }

  private trySend(msg: unknown): void {
    // If socket isn't open, pending RPCs will be re-sent on reconnect.
    this.sendRaw(msg)
  }

  private connectTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  // Initial-connect HINT (not force-close). Off-tailnet, the OS hangs the TCP
  // connect ~30 s before surfacing an error; this fires the disconnect
  // handlers at 5 s so the offline pill shows quickly. The WS itself keeps
  // trying — important on slow Tailscale-over-cellular paths where a real
  // connect can legitimately take 10–20 s. When it opens, onConnect fires
  // and flips the UI back to online.
  private readonly CONNECT_HINT_MS = 5_000

  private open(): void {
    if (this.stopped) return
    const url = `${getHubWsUrl()}/sync`
    const ws = new WebSocket(url)
    this.ws = ws

    this.connectTimeoutHandle = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        for (const fn of this.disconnectHandlers) {
          try { fn() } catch {}
        }
      }
    }, this.CONNECT_HINT_MS)

    ws.onopen = () => {
      if (this.connectTimeoutHandle) {
        clearTimeout(this.connectTimeoutHandle)
        this.connectTimeoutHandle = null
      }
      this.reconnectDelayMs = 500
      this.connectCount++
      const first = this.connectCount === 1
      // Re-establish subscriptions
      for (const service of this.subscribedServices) {
        this.sendRaw({ t: 'sub', service })
      }
      // Re-send pending RPCs (idempotency is the caller's responsibility —
      // for mutations the caller should include a client-side op id if needed)
      for (const [id, p] of this.pending) {
        this.sendRaw({ t: 'rpc', id, service: p.service, op: p.op, args: p.args })
      }
      // Fire connect handlers so callers can trigger catch-up RPCs.
      for (const fn of this.connectHandlers) {
        try { fn({ first }) } catch {}
      }
    }

    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data as string) } catch { return }
      if (!msg || typeof msg !== 'object') return
      switch (msg.t) {
        case 'hello':
          break
        case 'evt': {
          const key = `${msg.service}.${msg.op}`
          const set = this.subs.get(key)
          if (set) for (const fn of set) { try { fn(msg.data) } catch {} }
          const wild = this.subs.get(`${msg.service}.*`)
          if (wild) for (const fn of wild) { try { fn({ op: msg.op, data: msg.data }) } catch {} }
          break
        }
        case 'rpc': {
          const p = this.pending.get(msg.id)
          if (!p) return
          this.pending.delete(msg.id)
          if (p.timeoutHandle) clearTimeout(p.timeoutHandle)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'rpc failed'))
          break
        }
      }
    }

    ws.onclose = () => {
      if (this.connectTimeoutHandle) {
        clearTimeout(this.connectTimeoutHandle)
        this.connectTimeoutHandle = null
      }
      this.ws = null
      for (const fn of this.disconnectHandlers) {
        try { fn() } catch {}
      }
      if (this.stopped) return
      const delay = Math.min(this.reconnectDelayMs, this.MAX_RECONNECT_MS)
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.MAX_RECONNECT_MS)
      setTimeout(() => this.open(), delay)
    }

    ws.onerror = () => {
      // onclose will follow; reconnection handled there.
    }
  }
}

// Singleton used across the app.
export const hubBus = new HubSyncBus()
