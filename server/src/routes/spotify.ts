// Spotify routes — hub-side remote control over the Web API.
//
//   GET  /spotify/status                connection + spotifyd device state
//   GET  /spotify/player                fresh now-playing snapshot (forces a poll)
//   GET  /spotify/devices               available Connect devices
//   POST /spotify/play                  { contextUri?, uris?, offsetPosition?, positionMs?, deviceId? }
//   POST /spotify/pause | next | previous | toggle
//   POST /spotify/seek                  { positionMs }
//   POST /spotify/volume                { percent }
//   POST /spotify/shuffle               { state }
//   POST /spotify/repeat                { state: off|context|track }
//   POST /spotify/transfer              { deviceId, play? }
//   POST /spotify/queue                 { uri }
//   GET  /spotify/search?q=&limit=
//   GET  /spotify/playlists
//   GET  /spotify/playlist/<id>/tracks?limit=&offset=
//   GET  /spotify/saved-tracks?limit=&offset=
//   POST /spotify/save | /spotify/unsave  { ids: string[] }
//   GET  /spotify/saved?ids=a,b,c

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SpotifyClient } from '../spotify/client.js'
import type { SpotifyStore } from '../spotify/store.js'
import type { SpotifyPlayerSync } from '../spotify/sync.js'
import type { RepeatState } from '../spotify/types.js'

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function fail(res: ServerResponse, err: unknown): void {
  const e = err as Error & { status?: number }
  const status =
    e.name === 'SpotifyAuthError'
      ? 400
      : e.name === 'SpotifyRateLimitError'
        ? 429
        : (e.status && e.status >= 400 && e.status < 600 ? e.status : 500)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: e.message, kind: e.name }))
}

export function handleSpotifyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  client: SpotifyClient,
  store: SpotifyStore,
  sync: SpotifyPlayerSync,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/spotify')) return false

  // --- Read endpoints ---

  if (path === '/spotify/status' && req.method === 'GET') {
    client.getStatus().then((s) => json(res, s)).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/player' && req.method === 'GET') {
    // Force a fresh fetch so opening the drawer shows current state immediately.
    sync.syncNow().then((snap) => json(res, snap)).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/devices' && req.method === 'GET') {
    client.getDevices().then((d) => json(res, { devices: d })).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? '8')
    if (!q.trim()) {
      json(res, { tracks: [], albums: [], artists: [], playlists: [] })
      return true
    }
    client.search(q, limit).then((r) => json(res, r)).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/playlists' && req.method === 'GET') {
    client.getPlaylists().then((p) => json(res, { playlists: p })).catch((err) => fail(res, err))
    return true
  }

  const plMatch = /^\/spotify\/playlist\/([A-Za-z0-9]+)\/tracks$/.exec(path)
  if (plMatch && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    client.getPlaylistTracks(plMatch[1], limit, offset).then((t) => json(res, { tracks: t })).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/saved-tracks' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    client.getSavedTracks(limit, offset).then((t) => json(res, { tracks: t })).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/saved' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
    if (!ids.length) {
      json(res, { saved: [] })
      return true
    }
    client.tracksContains(ids).then((saved) => json(res, { saved })).catch((err) => fail(res, err))
    return true
  }

  // --- Control endpoints (all POST; poke the poller afterward) ---

  if (path === '/spotify/play' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const b = JSON.parse(body || '{}') as {
        contextUri?: string; uris?: string[]; offsetPosition?: number; positionMs?: number; deviceId?: string
      }
      await client.play(b)
      sync.pokeSoon()
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/toggle' && req.method === 'POST') {
    ;(async () => {
      // Fetch fresh state — the cached snapshot is stale when no drawer is open
      // (the poller is idle), and the media-key Play button maps here.
      const snap = await sync.syncNow()
      if (snap.isPlaying) await client.pause()
      else await client.play()
      sync.pokeSoon()
      json(res, { ok: true })
    })().catch((err) => fail(res, err))
    return true
  }

  const simple: Record<string, (deviceId?: string) => Promise<void>> = {
    '/spotify/pause': (d) => client.pause(d),
    '/spotify/next': (d) => client.next(d),
    '/spotify/previous': (d) => client.previous(d),
  }
  if (simple[path] && req.method === 'POST') {
    simple[path]().then(() => { sync.pokeSoon(); json(res, { ok: true }) }).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/seek' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { positionMs } = JSON.parse(body || '{}') as { positionMs: number }
      await client.seek(positionMs)
      sync.pokeSoon()
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/volume' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { percent } = JSON.parse(body || '{}') as { percent: number }
      await client.setVolume(percent)
      sync.pokeSoon()
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/shuffle' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { state } = JSON.parse(body || '{}') as { state: boolean }
      await client.setShuffle(state)
      sync.pokeSoon()
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/repeat' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { state } = JSON.parse(body || '{}') as { state: RepeatState }
      await client.setRepeat(state)
      sync.pokeSoon()
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/transfer' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { deviceId, play } = JSON.parse(body || '{}') as { deviceId: string; play?: boolean }
      if (!deviceId) throw new Error('transfer requires { deviceId }')
      await client.transfer(deviceId, play ?? true)
      sync.pokeSoon()
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  if (path === '/spotify/queue' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { uri } = JSON.parse(body || '{}') as { uri: string }
      if (!uri) throw new Error('queue requires { uri }')
      await client.queue(uri)
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  const plMut = /^\/spotify\/playlist\/([A-Za-z0-9]+)\/(add|remove)$/.exec(path)
  if (plMut && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { uris } = JSON.parse(body || '{}') as { uris: string[] }
      if (!Array.isArray(uris) || !uris.length) throw new Error(`${plMut[2]} requires { uris: [...] }`)
      if (plMut[2] === 'add') await client.addToPlaylist(plMut[1], uris)
      else await client.removeFromPlaylist(plMut[1], uris)
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  if ((path === '/spotify/save' || path === '/spotify/unsave') && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { ids } = JSON.parse(body || '{}') as { ids: string[] }
      if (!Array.isArray(ids) || !ids.length) throw new Error('save/unsave requires { ids: [...] }')
      if (path === '/spotify/save') await client.saveTracks(ids)
      else await client.removeTracks(ids)
      json(res, { ok: true })
    }).catch((err) => fail(res, err))
    return true
  }

  return false
}
