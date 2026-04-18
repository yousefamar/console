// Matrix CS API client — server-side port of src/matrix/api.ts
// Uses auth-store for token management

import type { AuthStore } from './auth-store.js'

class MatrixApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'MatrixApiError'
  }
}

export class MatrixClient {
  constructor(private authStore: AuthStore) {}

  private getConfig() {
    const config = this.authStore.getMatrixConfig()
    if (!config) throw new MatrixApiError(401, 'Not connected to Matrix. Run: con auth login matrix')
    return config
  }

  private async request<T>(
    path: string,
    opts: { method?: string; body?: unknown; params?: Record<string, string> } = {},
  ): Promise<T> {
    const config = this.getConfig()
    const url = new URL(`${config.homeserver}${path}`)
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        url.searchParams.set(k, v)
      }
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${config.accessToken}` }
    let body: string | undefined
    if (opts.body) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }

    const res = await fetch(url.toString(), { method: opts.method ?? 'GET', headers, body })

    if (!res.ok) {
      const text = await res.text()
      throw new MatrixApiError(res.status, `Matrix API ${res.status}: ${text}`)
    }

    const text = await res.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async sync(opts: { since?: string; timeout?: number } = {}) {
    const params: Record<string, string> = {}
    if (opts.since) params.since = opts.since
    if (opts.timeout !== undefined) params.timeout = String(opts.timeout)
    params.filter = JSON.stringify({
      room: {
        timeline: { limit: 50 },
        state: { lazy_load_members: true },
        account_data: {},
      },
      presence: { types: [] },
    })

    return this.request<MatrixSyncResponse>('/_matrix/client/v3/sync', { params })
  }

  async whoami() {
    return this.request<{ user_id: string; device_id?: string }>('/_matrix/client/v3/account/whoami')
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async getRoomMessages(roomId: string, opts: { from?: string; dir?: string; limit?: number } = {}) {
    const params: Record<string, string> = {
      dir: opts.dir ?? 'b',
      limit: String(opts.limit ?? 50),
    }
    if (opts.from) params.from = opts.from

    return this.request<MatrixMessagesResponse>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      { params },
    )
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  async sendMessage(roomId: string, body: string, formattedBody?: string) {
    const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`
    const content: Record<string, unknown> = { msgtype: 'm.text', body }
    if (formattedBody) {
      content.format = 'org.matrix.custom.html'
      content.formatted_body = formattedBody
    }

    return this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      { method: 'PUT', body: content },
    )
  }

  async sendReaction(roomId: string, targetEventId: string, emoji: string) {
    const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`
    return this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
      {
        method: 'PUT',
        body: {
          'm.relates_to': { rel_type: 'm.annotation', event_id: targetEventId, key: emoji },
        },
      },
    )
  }

  // -------------------------------------------------------------------------
  // Read receipts
  // -------------------------------------------------------------------------

  async sendReadReceipt(roomId: string, eventId: string) {
    return this.request(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      { method: 'POST', body: {} },
    )
  }

  async setReadMarker(roomId: string, eventId: string) {
    return this.request(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      { method: 'POST', body: { 'm.fully_read': eventId, 'm.read': eventId } },
    )
  }

  // -------------------------------------------------------------------------
  // Room info
  // -------------------------------------------------------------------------

  async getRoomState(roomId: string) {
    return this.request<unknown[]>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
    )
  }

  async getJoinedRooms() {
    return this.request<{ joined_rooms: string[] }>('/_matrix/client/v3/joined_rooms')
  }

  async getEvent(roomId: string, eventId: string) {
    return this.request<Record<string, unknown>>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    )
  }

  async urlPreview(url: string) {
    return this.request<Record<string, unknown>>(
      '/_matrix/media/v3/preview_url',
      { params: { url, ts: String(Date.now()) } },
    )
  }

  /** Proxy a GET request to /_matrix/media/v3/... returning the raw Response. */
  async mediaFetch(path: string): Promise<Response> {
    const config = this.getConfig()
    const url = `${config.homeserver}${path}`
    return fetch(url, { headers: { Authorization: `Bearer ${config.accessToken}` } })
  }

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  async sendRoomEvent(roomId: string, eventType: string, content: Record<string, unknown>) {
    const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`
    return this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${txnId}`,
      { method: 'PUT', body: content },
    )
  }

  async uploadMedia(data: Buffer, contentType: string, filename?: string) {
    const config = this.getConfig()
    const url = new URL(`${config.homeserver}/_matrix/media/v3/upload`)
    if (filename) url.searchParams.set('filename', filename)

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(data),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new MatrixApiError(res.status, `Upload failed: ${text}`)
    }

    return res.json() as Promise<{ content_uri: string }>
  }
}

// -------------------------------------------------------------------------
// Types (minimal, for server use)
// -------------------------------------------------------------------------

export interface MatrixSyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, MatrixJoinedRoom>
    leave?: Record<string, unknown>
    invite?: Record<string, unknown>
  }
  to_device?: { events: unknown[] }
  device_lists?: { changed?: string[]; left?: string[] }
  device_one_time_keys_count?: Record<string, number>
  account_data?: { events?: MatrixEvent[] }
}

interface MatrixJoinedRoom {
  timeline: { events: MatrixEvent[]; prev_batch?: string; limited?: boolean }
  state: { events: MatrixEvent[] }
  ephemeral?: { events: MatrixEvent[] }
  unread_notifications?: { notification_count?: number; highlight_count?: number }
  summary?: { 'm.heroes'?: string[]; 'm.joined_member_count'?: number; 'm.invited_member_count'?: number }
}

export interface MatrixEvent {
  type: string
  content: Record<string, unknown>
  event_id?: string
  sender?: string
  origin_server_ts?: number
  state_key?: string
  unsigned?: Record<string, unknown>
}

interface MatrixMessagesResponse {
  start: string
  end?: string
  chunk: MatrixEvent[]
  state?: MatrixEvent[]
}
