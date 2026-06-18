// Push notification broadcaster.
//
// The Android APK opens a persistent WebSocket to `/push` from a foreground
// service (see `android/app/src/main/kotlin/io/amar/console/PushService.kt`).
// While the APK is backgrounded or killed the WebView is frozen, so browser
// Notification API + in-app toast don't fire. The foreground service keeps
// this WebSocket alive, and posts an Android system notification per message.
//
// Server-side sources (Monzo webhook, agent AskUserQuestion, `POST /push/send`)
// call `pushBroadcast(...)` to emit a message to every connected push client.

import type { WebSocket } from 'ws'

export interface PushMessage {
  /** Notification category — drives channel + default pane routing */
  type: 'mail' | 'chat' | 'calendar' | 'agent' | 'money' | 'generic'
  /** If true, dismiss the matching notification instead of posting one.
   *  Match keys are channel-specific (roomId for chat; account+threadId for
   *  mail; id for agent/money/generic). title/body may be omitted. */
  cancel?: boolean
  title?: string
  body?: string
  /** Optional pane to navigate to when tapped (e.g. "agents", "money") */
  pane?: string
  /** Optional stable ID so repeat pushes update the same notification */
  id?: string
  /** Optional extra JSON for richer UI (unused by default handler) */
  data?: Record<string, unknown>

  // --- Chat-specific fields (populated for type:'chat') --------------------
  // The Android PushService uses these to build MessagingStyle notifications
  // with grouping, sender avatars, and deep-links to the specific room.
  /** Matrix room ID — stable grouping key + deep-link target */
  roomId?: string
  /** Room display name (falls back to title) */
  roomName?: string
  /** Sender display name */
  senderName?: string
  /** Sender MXID (stable identifier for Person objects) */
  senderId?: string
  /** Sender avatar — mxc:// URL (APK resolves via hub thumbnailer) */
  senderAvatarMxc?: string
  /** Room avatar — mxc:// URL */
  roomAvatarMxc?: string
  /** True if this is a 1:1 DM (drives notification style) */
  isDirect?: boolean
  /** Event origin_server_ts — for MessagingStyle message ordering */
  timestamp?: number

  // --- Mail-specific fields (populated for type:'mail') --------------------
  // One push per thread so Android can render Gmail-style per-sender
  // notifications grouped under a single "Mail" summary. Archive / Mark as
  // Read actions on the APK call back to /mail/threads/:id/... with these.
  /** Gmail account (e.g. "user@gmail.com") the delta belongs to */
  account?: string
  /** Thread ID — Archive / Mark-as-Read actions act on this thread */
  threadId?: string
  /** Message ID (newest in the thread) — reserved for future per-message ops */
  messageId?: string
  /** Display name parsed from the `From:` header (falls back to `fromEmail`) */
  fromName?: string
  /** Email address parsed from the `From:` header */
  fromEmail?: string
  /** `Subject:` header */
  subject?: string
  /** Gmail-generated short preview of the message body */
  snippet?: string
}

/** Inbound-from-APK frame handler. Return true if consumed. */
export type PushInboundHandler = (ws: WebSocket, frame: unknown) => boolean

export class PushServer {
  private readonly clients = new Set<WebSocket>()
  private readonly inboundHandlers: PushInboundHandler[] = []
  private readonly log: (msg: string) => void

  constructor(log: (msg: string) => void) {
    this.log = log
  }

  /** Register a handler for inbound JSON frames from the APK. */
  onInbound(handler: PushInboundHandler): void {
    this.inboundHandlers.push(handler)
  }

  /** Fired once per client connection, after the hello is sent. Used to sweep
   *  stale notifications (cancel anything for rooms now read) — the only way
   *  to clear notifications orphaned by a hub restart, since the in-memory
   *  pushed-rooms tracking doesn't survive one. */
  private readonly connectHandlers: Array<() => void> = []
  onConnect(handler: () => void): void {
    this.connectHandlers.push(handler)
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws)
    this.log(`[push] Client connected (${this.clients.size} total)`)

    ws.on('message', (data) => {
      let frame: unknown
      try { frame = JSON.parse(data.toString()) } catch { return }
      for (const h of this.inboundHandlers) {
        try { if (h(ws, frame)) return } catch (e) { this.log(`[push] inbound handler failed: ${(e as Error).message}`) }
      }
    })

    ws.on('close', () => {
      this.clients.delete(ws)
      this.log(`[push] Client disconnected (${this.clients.size} remaining)`)
    })
    ws.on('error', () => { /* close will fire after */ })

    // Send a hello so the Android side can confirm the channel is up.
    try {
      ws.send(JSON.stringify({ type: 'hello', time: Date.now() }))
    } catch { /* ignore */ }

    for (const h of this.connectHandlers) {
      try { h() } catch (e) { this.log(`[push] connect handler failed: ${(e as Error).message}`) }
    }
  }

  broadcast(msg: PushMessage): void {
    if (this.clients.size === 0) return
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      try {
        if (ws.readyState === 1 /* OPEN */) ws.send(data)
      } catch { /* ignore — will be cleaned up by close listener */ }
    }
  }

  /** Low-level: broadcast a pre-serialized JSON string (for RPC frames). */
  broadcastRaw(data: string): void {
    for (const ws of this.clients) {
      try {
        if (ws.readyState === 1 /* OPEN */) ws.send(data)
      } catch { /* ignore */ }
    }
  }

  clientCount(): number {
    return this.clients.size
  }
}
