import { getMatrixAccessToken, getMatrixHomeserver } from './auth'
import type {
  MatrixSyncResponse,
  MatrixMessagesResponse,
  MatrixRoomEvent,
  MatrixWhoamiResponse,
} from './types'

class MatrixApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<T> {
  const token = getMatrixAccessToken()
  const hs = getMatrixHomeserver()
  if (!token || !hs) throw new MatrixApiError(401, 'Not connected to Matrix')

  const url = new URL(`${hs}${path}`)
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, v)
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  let body: string | undefined
  if (opts.body) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new MatrixApiError(res.status, `Matrix API ${res.status}: ${text}`)
  }

  // Some endpoints return empty body (e.g., read markers)
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

// --- Sync ---

export async function sync(opts: {
  since?: string
  timeout?: number
  filter?: string
}): Promise<MatrixSyncResponse> {
  const params: Record<string, string> = {}
  if (opts.since) params.since = opts.since
  if (opts.timeout !== undefined) params.timeout = String(opts.timeout)
  if (opts.filter) params.filter = opts.filter

  // Use a minimal filter to reduce sync payload
  if (!opts.filter) {
    params.filter = JSON.stringify({
      room: {
        timeline: { limit: 50 },
        state: { lazy_load_members: true },
        account_data: {},
      },
      presence: { types: [] }, // skip presence updates
    })
  }

  return request<MatrixSyncResponse>('/_matrix/client/v3/sync', { params })
}

// --- Who Am I ---

export async function whoami(): Promise<MatrixWhoamiResponse> {
  return request<MatrixWhoamiResponse>('/_matrix/client/v3/account/whoami')
}

// --- Single Event ---

export async function getEvent(roomId: string, eventId: string): Promise<MatrixRoomEvent> {
  return request<MatrixRoomEvent>(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
  )
}

// --- URL Preview ---

export interface UrlPreview {
  'og:title'?: string
  'og:description'?: string
  'og:image'?: string
  'og:image:type'?: string
  'og:image:width'?: number
  'og:image:height'?: number
  'matrix:image:size'?: number
}

let previewUrlDisabled = localStorage.getItem('matrix_preview_url_disabled') === '1'

export async function getUrlPreview(url: string): Promise<UrlPreview> {
  if (previewUrlDisabled) return {}
  try {
    return await request<UrlPreview>('/_matrix/media/v3/preview_url', {
      params: { url, ts: String(Date.now()) },
    })
  } catch (err) {
    if (err instanceof MatrixApiError && err.status === 404) {
      // Server doesn't support preview_url — stop calling it (persisted across reloads)
      previewUrlDisabled = true
      localStorage.setItem('matrix_preview_url_disabled', '1')
      return {}
    }
    throw err
  }
}

// --- Room Messages (pagination) ---

export async function getRoomMessages(
  roomId: string,
  opts: { from?: string; dir?: 'b' | 'f'; limit?: number } = {},
): Promise<MatrixMessagesResponse> {
  const params: Record<string, string> = {
    dir: opts.dir ?? 'b',
    limit: String(opts.limit ?? 50),
  }
  if (opts.from) params.from = opts.from

  const encoded = encodeURIComponent(roomId)
  return request<MatrixMessagesResponse>(`/_matrix/client/v3/rooms/${encoded}/messages`, { params })
}

// --- Send Message ---

export async function sendMessage(
  roomId: string,
  body: string,
  formattedBody?: string,
): Promise<MatrixRoomEvent> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`
  const encoded = encodeURIComponent(roomId)

  const content: Record<string, unknown> = {
    msgtype: 'm.text',
    body,
  }
  if (formattedBody) {
    content.format = 'org.matrix.custom.html'
    content.formatted_body = formattedBody
  }

  return request<MatrixRoomEvent>(
    `/_matrix/client/v3/rooms/${encoded}/send/m.room.message/${txnId}`,
    { method: 'PUT', body: content },
  )
}

// --- Send Room Event (generic, for m.image etc.) ---

export async function sendRoomEvent(
  roomId: string,
  eventType: string,
  content: Record<string, unknown>,
): Promise<MatrixRoomEvent> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`
  const encoded = encodeURIComponent(roomId)

  return request<MatrixRoomEvent>(
    `/_matrix/client/v3/rooms/${encoded}/send/${encodeURIComponent(eventType)}/${txnId}`,
    { method: 'PUT', body: content },
  )
}

// --- Send Encrypted Message ---

export async function sendEncryptedMessage(
  roomId: string,
  encryptedContent: Record<string, unknown>,
): Promise<MatrixRoomEvent> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`
  const encoded = encodeURIComponent(roomId)

  return request<MatrixRoomEvent>(
    `/_matrix/client/v3/rooms/${encoded}/send/m.room.encrypted/${txnId}`,
    { method: 'PUT', body: encryptedContent },
  )
}

// --- Send Reaction ---

export async function sendReaction(
  roomId: string,
  targetEventId: string,
  emoji: string,
): Promise<{ event_id?: string }> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2)}`
  const encoded = encodeURIComponent(roomId)
  return request<{ event_id?: string }>(
    `/_matrix/client/v3/rooms/${encoded}/send/m.reaction/${txnId}`,
    {
      method: 'PUT',
      body: {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: targetEventId,
          key: emoji,
        },
      },
    },
  )
}

// --- Send Read Receipt ---

export async function sendReadReceipt(roomId: string, eventId: string): Promise<void> {
  const encodedRoom = encodeURIComponent(roomId)
  const encodedEvent = encodeURIComponent(eventId)

  await request(
    `/_matrix/client/v3/rooms/${encodedRoom}/receipt/m.read/${encodedEvent}`,
    { method: 'POST', body: {} },
  )
}

// --- Set Read Marker (fully read position) ---

export async function setReadMarker(roomId: string, eventId: string): Promise<void> {
  const encoded = encodeURIComponent(roomId)
  await request(
    `/_matrix/client/v3/rooms/${encoded}/read_markers`,
    {
      method: 'POST',
      body: {
        'm.fully_read': eventId,
        'm.read': eventId,
      },
    },
  )
}

// --- Typing Indicator ---

export async function sendTyping(roomId: string, typing: boolean, timeout = 10000): Promise<void> {
  const hs = getMatrixHomeserver()
  const token = getMatrixAccessToken()
  if (!hs || !token) return

  // We need our userId for this endpoint
  const userId = localStorage.getItem('matrix_user_id')
  if (!userId) return

  const encodedRoom = encodeURIComponent(roomId)
  const encodedUser = encodeURIComponent(userId)

  await request(
    `/_matrix/client/v3/rooms/${encodedRoom}/typing/${encodedUser}`,
    { method: 'PUT', body: { typing, timeout } },
  )
}

// --- Room State ---

export async function getRoomState(roomId: string): Promise<MatrixRoomEvent[]> {
  const encoded = encodeURIComponent(roomId)
  return request<MatrixRoomEvent[]>(`/_matrix/client/v3/rooms/${encoded}/state`)
}

// --- Join Room ---

export async function joinRoom(roomIdOrAlias: string): Promise<{ room_id: string }> {
  const encoded = encodeURIComponent(roomIdOrAlias)
  return request<{ room_id: string }>(
    `/_matrix/client/v3/join/${encoded}`,
    { method: 'POST', body: {} },
  )
}

// --- Leave Room ---

export async function leaveRoom(roomId: string): Promise<void> {
  const encoded = encodeURIComponent(roomId)
  await request(
    `/_matrix/client/v3/rooms/${encoded}/leave`,
    { method: 'POST', body: {} },
  )
}

// --- Upload Media ---

export async function uploadMedia(
  data: ArrayBuffer,
  contentType: string,
  filename?: string,
): Promise<string> {
  const token = getMatrixAccessToken()
  const hs = getMatrixHomeserver()
  if (!token || !hs) throw new MatrixApiError(401, 'Not connected to Matrix')

  const params = new URLSearchParams()
  if (filename) params.set('filename', filename)

  const res = await fetch(`${hs}/_matrix/media/v3/upload?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body: data,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new MatrixApiError(res.status, `Upload failed: ${text}`)
  }
  const json = await res.json() as { content_uri: string }
  return json.content_uri
}

// --- MXC URL to HTTP URL ---

export function mxcToHttp(mxcUrl: string): string | undefined {
  const hs = getMatrixHomeserver()
  if (!hs || !mxcUrl.startsWith('mxc://')) return undefined

  // mxc://server/mediaId → /_matrix/media/v3/download/server/mediaId
  const parts = mxcUrl.slice(6) // remove "mxc://"
  return `${hs}/_matrix/media/v3/download/${parts}`
}

export function mxcToThumbnail(
  mxcUrl: string,
  width = 48,
  height = 48,
  method: 'crop' | 'scale' = 'crop',
): string | undefined {
  const hs = getMatrixHomeserver()
  if (!hs || !mxcUrl.startsWith('mxc://')) return undefined

  const parts = mxcUrl.slice(6)
  return `${hs}/_matrix/media/v3/thumbnail/${parts}?width=${width}&height=${height}&method=${method}`
}
