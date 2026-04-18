// Matrix client-server calls, proxied through the hub.
//
// The hub (see server/src/routes/matrix.ts) owns the access token; this module
// just speaks plain REST against the hub so the browser never sees the
// homeserver Authorization header. With M3, the browser also no longer drives
// /sync, sends, pagination, or read receipts — those go through hubBus RPCs on
// src/sync-bus.ts. What remains here are a few endpoints used by views:
//
//   - getRoomState / getEvent       — used by send-path + migrations
//   - getUrlPreview                  — message bubble link previews
//   - uploadMedia                    — chat attachment send
//   - mxcToHttp / mxcToThumbnail     — <img src=…> generators pointing at hub
//
// All functions return hub-relative URLs or proxied responses.

import { getHubUrl } from '@/hub'
import type { MatrixRoomEvent } from './types'

class MatrixApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function hubRequest<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getHubUrl()}${path}`, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new MatrixApiError(res.status, `${path} ${res.status}: ${text}`)
  }
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
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
    return await hubRequest<UrlPreview>(
      `/matrix/url-preview?url=${encodeURIComponent(url)}`,
    )
  } catch (err) {
    if (err instanceof MatrixApiError && err.status === 404) {
      previewUrlDisabled = true
      localStorage.setItem('matrix_preview_url_disabled', '1')
      return {}
    }
    throw err
  }
}

// --- Single event (backfill only — live events come via sync-bus deltas) ---

export async function getEvent(roomId: string, eventId: string): Promise<MatrixRoomEvent> {
  return hubRequest<MatrixRoomEvent>(
    `/matrix/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
  )
}

// --- Room state (raw CS-API state events) ---

export async function getRoomState(roomId: string): Promise<MatrixRoomEvent[]> {
  return hubRequest<MatrixRoomEvent[]>(
    `/matrix/rooms/${encodeURIComponent(roomId)}/state`,
  )
}

// --- Upload Media ---

export async function uploadMedia(
  data: ArrayBuffer,
  contentType: string,
  filename?: string,
): Promise<string> {
  const params = new URLSearchParams()
  if (filename) params.set('filename', filename)

  const res = await fetch(`${getHubUrl()}/matrix/media/upload?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: data,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new MatrixApiError(res.status, `Upload failed: ${text}`)
  }
  const json = await res.json() as { content_uri: string }
  return json.content_uri
}

// --- MXC → hub HTTP URL ---
//
// Rather than hitting the homeserver's /_matrix/media/v3/download directly
// (which now requires auth under MSC3916), point <img src> at the hub, which
// proxies with its access token. Hub paths mirror the CS-API shape.

export function mxcToHttp(mxcUrl: string): string | undefined {
  if (!mxcUrl.startsWith('mxc://')) return undefined
  const [server, mediaId] = mxcUrl.slice(6).split('/', 2)
  if (!server || !mediaId) return undefined
  return `${getHubUrl()}/matrix/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`
}

export function mxcToThumbnail(
  mxcUrl: string,
  width = 48,
  height = 48,
  method: 'crop' | 'scale' = 'crop',
): string | undefined {
  if (!mxcUrl.startsWith('mxc://')) return undefined
  const [server, mediaId] = mxcUrl.slice(6).split('/', 2)
  if (!server || !mediaId) return undefined
  return `${getHubUrl()}/matrix/media/thumbnail/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}?width=${width}&height=${height}&method=${method}`
}
