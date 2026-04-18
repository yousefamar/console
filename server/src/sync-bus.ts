// ============================================================================
// Sync Bus — bidirectional WebSocket substrate for hub ⇄ browser.
//
// Every service (mail, calendar, matrix, prefs, …) registers RPC handlers
// against this bus. Browsers connect on `/sync`, subscribe to events by
// service, and make RPC calls through the same socket. Hub broadcasts
// events as authoritative state changes happen (sync loop ticks, webhooks).
//
// Wire protocol (all JSON):
//   S→C:  {t:'hello', ts}
//         {t:'evt', service, op, data}
//         {t:'rpc', id, ok, result?, error?}
//   C→S:  {t:'sub', service}          // subscribe to a service's events
//         {t:'unsub', service}
//         {t:'rpc', id, service, op, args}
//         {t:'ping'}                  // keepalive (optional)
// ============================================================================

import type { WebSocket } from 'ws'

export type SyncEvent = {
  service: string
  op: string
  data: unknown
}

export type RpcContext = {
  ws: WebSocket
  /** Broadcast an event to the same client (or everyone via bus.broadcast). */
  reply: (service: string, op: string, data: unknown) => void
}

export type RpcHandler = (args: unknown, ctx: RpcContext) => Promise<unknown> | unknown

type Client = {
  ws: WebSocket
  subs: Set<string> // service names the client cares about
}

export class SyncBus {
  private clients = new Set<Client>()
  private handlers = new Map<string, RpcHandler>() // key: `${service}.${op}`

  constructor(private log: (msg: string) => void = () => {}) {}

  /** Register one or more RPC ops for a service. */
  register(service: string, ops: Record<string, RpcHandler>): void {
    for (const [op, fn] of Object.entries(ops)) {
      this.handlers.set(`${service}.${op}`, fn)
    }
  }

  /** Broadcast an event to all clients subscribed to this service. */
  broadcast(service: string, op: string, data: unknown): void {
    const msg = JSON.stringify({ t: 'evt', service, op, data })
    for (const c of this.clients) {
      if (c.subs.has(service) && c.ws.readyState === 1 /* OPEN */) {
        c.ws.send(msg)
      }
    }
  }

  /** Send an event to one specific WS, regardless of subscription state. */
  send(ws: WebSocket, service: string, op: string, data: unknown): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'evt', service, op, data }))
    }
  }

  /** Number of clients subscribed to a given service. */
  subscriberCount(service: string): number {
    let n = 0
    for (const c of this.clients) if (c.subs.has(service)) n++
    return n
  }

  /** Attach a newly-connected WebSocket to the bus. Takes over message handling. */
  attach(ws: WebSocket): void {
    const client: Client = { ws, subs: new Set() }
    this.clients.add(client)

    try { ws.send(JSON.stringify({ t: 'hello', ts: Date.now() })) } catch {}

    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!msg || typeof msg !== 'object') return
      switch (msg.t) {
        case 'sub':
          if (typeof msg.service === 'string') client.subs.add(msg.service)
          break
        case 'unsub':
          if (typeof msg.service === 'string') client.subs.delete(msg.service)
          break
        case 'ping':
          try { ws.send(JSON.stringify({ t: 'pong' })) } catch {}
          break
        case 'rpc':
          this.handleRpc(ws, msg)
          break
      }
    })

    ws.on('close', () => {
      this.clients.delete(client)
    })
    ws.on('error', () => {
      this.clients.delete(client)
    })
  }

  private async handleRpc(ws: WebSocket, msg: any): Promise<void> {
    const { id, service, op, args } = msg
    if (typeof id !== 'number' && typeof id !== 'string') return
    const key = `${service}.${op}`
    const fn = this.handlers.get(key)
    if (!fn) {
      try { ws.send(JSON.stringify({ t: 'rpc', id, ok: false, error: `unknown op: ${key}` })) } catch {}
      return
    }
    const ctx: RpcContext = {
      ws,
      reply: (s, o, d) => this.send(ws, s, o, d),
    }
    try {
      const result = await fn(args, ctx)
      try { ws.send(JSON.stringify({ t: 'rpc', id, ok: true, result })) } catch {}
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[sync-bus] ${key} failed: ${message}`)
      try { ws.send(JSON.stringify({ t: 'rpc', id, ok: false, error: message })) } catch {}
    }
  }
}
