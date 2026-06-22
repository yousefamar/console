// con music — control Spotify playback through the hub.
//
// The hub is a remote control over the Spotify Web API; playback runs on the
// local spotifyd Connect device. This is the target for system-wide media keys:
// bind XF86AudioPlay/Next/Prev in Sway to `con music play|next|prev`. Unlike
// MPRIS/playerctl, `con music play` works even when spotifyd is idle/cold —
// the Web API can start playback on the device from nothing.

import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

interface Snapshot {
  linked: boolean
  isPlaying: boolean
  device: { id: string | null; name: string; volumePercent: number | null } | null
  item: { name: string; artists: string; durationMs: number; uri: string; id: string | null } | null
  progressMs: number
  shuffle: boolean
  repeat: 'off' | 'context' | 'track'
  devices: { id: string | null; name: string; isActive: boolean; volumePercent: number | null }[]
  spotifydDeviceId: string | null
}

interface Track { id: string | null; uri: string; name: string; artists: string }
interface Playlist { id: string; uri: string; name: string; trackCount: number }
interface SearchResults { tracks: Track[]; albums: { uri: string | null; name: string }[]; artists: { uri: string; name: string }[]; playlists: Playlist[] }

export async function music(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case undefined:
    case 'now':
    case 'current': return musicNow(flags)
    case 'status': return musicStatus(flags)
    case 'play': return musicPlay(args, flags)
    case 'pause': return musicSimple('/spotify/pause', flags)
    case 'toggle': return musicSimple('/spotify/toggle', flags)
    case 'next': return musicSimple('/spotify/next', flags)
    case 'prev':
    case 'previous': return musicSimple('/spotify/previous', flags)
    case 'stop': return musicSimple('/spotify/pause', flags) // no native stop; pause
    case 'vol':
    case 'volume': return musicVolume(args, flags)
    case 'seek': return musicSeek(args, flags)
    case 'shuffle': return musicShuffle(args, flags)
    case 'repeat': return musicRepeat(args, flags)
    case 'devices': return musicDevices(flags)
    case 'transfer': return musicTransfer(args, flags)
    case 'search': return musicSearch(args, flags)
    case 'queue': return musicQueue(args, flags)
    case 'playlists': return musicPlaylists(flags)
    case 'liked': return musicLiked(flags)
    case 'add': return musicAdd(args, flags, 'add')
    case 'remove': return musicAdd(args, flags, 'remove')
    case 'like': return musicLike(true, flags)
    case 'unlike': return musicLike(false, flags)
    default:
      exitWithError('USAGE', `Unknown music command: ${verb}. Try: now, play, pause, next, prev, vol, seek, devices, transfer, search, playlists, liked, queue, add, like.`, flags)
  }
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function getSnapshot(): Promise<Snapshot> {
  return hubFetch<Snapshot>('/spotify/player')
}

async function musicNow(flags: GlobalFlags): Promise<void> {
  const snap = await getSnapshot()
  if (flags.json) return output(snap, flags)
  if (!snap.linked) {
    console.log('Spotify not linked — run the authorize flow first.')
    return
  }
  if (!snap.item) {
    console.log('Nothing playing.')
    return
  }
  const icon = snap.isPlaying ? '▶' : '⏸'
  const pos = `${fmtMs(snap.progressMs)}/${fmtMs(snap.item.durationMs)}`
  const flagsStr = [snap.shuffle ? '🔀' : '', snap.repeat !== 'off' ? '🔁' : ''].filter(Boolean).join(' ')
  const dev = snap.device ? ` 🔊${snap.device.volumePercent ?? '?'} · ${snap.device.name}` : ''
  console.log(`${icon} ${snap.item.name} — ${snap.item.artists} [${pos}]${flagsStr ? ' ' + flagsStr : ''}${dev}`)
}

async function musicStatus(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/spotify/status'), flags)
}

async function musicSimple(path: string, flags: GlobalFlags): Promise<void> {
  output(await hubFetch(path, { method: 'POST' }), flags)
}

async function musicPlay(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const positional = args.find((a) => !a.startsWith('--'))

  // Typed context play: --playlist / --album / --artist <name>
  const ctxType = (['playlist', 'album', 'artist'] as const).find((t) => opts[t] != null)
  if (ctxType) {
    const name = typeof opts[ctxType] === 'string' && opts[ctxType] !== 'true' ? opts[ctxType] : positional
    if (!name) return exitWithError('USAGE', `con music play --${ctxType} "<name>"`, flags)
    const r = await hubFetch<SearchResults>('/spotify/search', { params: { q: name, limit: '1' } })
    const item = ctxType === 'playlist' ? r.playlists?.[0] : ctxType === 'album' ? r.albums?.[0] : r.artists?.[0]
    if (!item?.uri) return exitWithError('USAGE', `No ${ctxType} found for "${name}"`, flags)
    await hubFetch('/spotify/play', { method: 'POST', body: { contextUri: item.uri } })
    return output({ ok: true, playing: item.name }, flags)
  }

  // No argument → play/pause toggle (the natural media-key behaviour).
  if (!positional) return musicSimple('/spotify/toggle', flags)

  if (positional.startsWith('spotify:')) {
    const body = positional.includes(':track:') ? { uris: [positional] } : { contextUri: positional }
    await hubFetch('/spotify/play', { method: 'POST', body })
    return output({ ok: true }, flags)
  }

  // Free-text → play the top track match.
  const r = await hubFetch<SearchResults>('/spotify/search', { params: { q: positional, limit: '1' } })
  const track = r.tracks?.[0]
  if (!track) return exitWithError('USAGE', `No track found for "${positional}"`, flags)
  await hubFetch('/spotify/play', { method: 'POST', body: { uris: [track.uri] } })
  output({ ok: true, playing: `${track.name} — ${track.artists}` }, flags)
}

async function musicPlaylists(flags: GlobalFlags): Promise<void> {
  const r = await hubFetch<{ playlists: Playlist[] }>('/spotify/playlists')
  if (flags.json) return output(r, flags)
  if (!r.playlists?.length) {
    console.log('No playlists.')
    return
  }
  for (const p of r.playlists) console.log(`${p.name}  (${p.trackCount})  ${p.uri}`)
}

async function musicLiked(flags: GlobalFlags): Promise<void> {
  const r = await hubFetch<{ tracks: Track[] }>('/spotify/saved-tracks?limit=50')
  const uris = (r.tracks ?? []).map((t) => t.uri)
  if (!uris.length) return exitWithError('USAGE', 'No liked songs found', flags)
  await hubFetch('/spotify/play', { method: 'POST', body: { uris } })
  output({ ok: true, playing: `${uris.length} liked songs` }, flags)
}

async function musicAdd(args: string[], flags: GlobalFlags, op: 'add' | 'remove'): Promise<void> {
  const positionals = args.filter((a) => !a.startsWith('--'))
  const plArg = positionals[0]
  const trackArg = positionals[1]
  if (!plArg) return exitWithError('USAGE', `con music ${op} <playlist name|uri> [track query|uri]  (track defaults to now-playing)`, flags)

  // Resolve playlist id.
  let plId: string | undefined
  let plName = plArg
  if (plArg.startsWith('spotify:playlist:')) {
    plId = plArg.split(':').pop()
  } else {
    const r = await hubFetch<{ playlists: Playlist[] }>('/spotify/playlists')
    const m = r.playlists.find((p) => p.id === plArg)
      ?? r.playlists.find((p) => p.name.toLowerCase().includes(plArg.toLowerCase()))
    if (!m) return exitWithError('USAGE', `No playlist matching "${plArg}"`, flags)
    plId = m.id
    plName = m.name
  }

  // Resolve track uri (current track if omitted).
  let uri: string | undefined
  let label: string | undefined = trackArg
  if (!trackArg) {
    const snap = await getSnapshot()
    uri = snap.item?.uri
    label = snap.item ? `${snap.item.name}` : undefined
    if (!uri) return exitWithError('USAGE', 'Nothing playing — specify a track', flags)
  } else if (trackArg.startsWith('spotify:')) {
    uri = trackArg
  } else {
    const r = await hubFetch<SearchResults>('/spotify/search', { params: { q: trackArg, limit: '1' } })
    const t = r.tracks?.[0]
    if (!t) return exitWithError('USAGE', `No track found for "${trackArg}"`, flags)
    uri = t.uri
    label = `${t.name} — ${t.artists}`
  }

  await hubFetch(`/spotify/playlist/${plId}/${op}`, { method: 'POST', body: { uris: [uri] } })
  output({ ok: true, [op === 'add' ? 'added' : 'removed']: label, playlist: plName }, flags)
}

async function musicVolume(args: string[], flags: GlobalFlags): Promise<void> {
  const arg = args.find((a) => !a.startsWith('--'))
  if (!arg) return exitWithError('USAGE', 'Usage: con music vol <0-100 | +N | -N>', flags)
  let percent: number
  if (arg.startsWith('+') || arg.startsWith('-')) {
    const snap = await getSnapshot()
    const cur = snap.device?.volumePercent ?? 50
    percent = cur + Number(arg)
  } else {
    percent = Number(arg)
  }
  if (Number.isNaN(percent)) return exitWithError('USAGE', 'Volume must be a number', flags)
  percent = Math.max(0, Math.min(100, percent))
  await hubFetch('/spotify/volume', { method: 'POST', body: { percent } })
  output({ ok: true, volume: percent }, flags)
}

async function musicSeek(args: string[], flags: GlobalFlags): Promise<void> {
  const arg = args.find((a) => !a.startsWith('--'))
  if (!arg) return exitWithError('USAGE', 'Usage: con music seek <seconds | +N | -N>', flags)
  const snap = await getSnapshot()
  const secs = Number(arg.replace('+', ''))
  if (Number.isNaN(secs)) return exitWithError('USAGE', 'Seek must be a number of seconds', flags)
  let positionMs: number
  if (arg.startsWith('+')) positionMs = snap.progressMs + secs * 1000
  else if (arg.startsWith('-')) positionMs = Math.max(0, snap.progressMs + secs * 1000) // secs already negative
  else positionMs = secs * 1000
  await hubFetch('/spotify/seek', { method: 'POST', body: { positionMs } })
  output({ ok: true, positionMs }, flags)
}

async function musicShuffle(args: string[], flags: GlobalFlags): Promise<void> {
  const arg = (args.find((a) => !a.startsWith('--')) ?? 'toggle').toLowerCase()
  let state: boolean
  if (arg === 'on') state = true
  else if (arg === 'off') state = false
  else {
    const snap = await getSnapshot()
    state = !snap.shuffle
  }
  try {
    await hubFetch('/spotify/shuffle', { method: 'POST', body: { state } })
    output({ ok: true, shuffle: state }, flags)
  } catch (e) {
    if (isRestriction(e)) return notSupported('shuffle', flags)
    throw e
  }
}

async function musicRepeat(args: string[], flags: GlobalFlags): Promise<void> {
  const arg = (args.find((a) => !a.startsWith('--')) ?? 'cycle').toLowerCase()
  let state: 'off' | 'context' | 'track'
  if (arg === 'off' || arg === 'context' || arg === 'track') {
    state = arg
  } else {
    const snap = await getSnapshot()
    state = snap.repeat === 'off' ? 'context' : snap.repeat === 'context' ? 'track' : 'off'
  }
  try {
    await hubFetch('/spotify/repeat', { method: 'POST', body: { state } })
    output({ ok: true, repeat: state }, flags)
  } catch (e) {
    if (isRestriction(e)) return notSupported('repeat', flags)
    throw e
  }
}

/** spotifyd/librespot returns 403 "Restriction violated" for shuffle/repeat. */
function isRestriction(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('403') || msg.toLowerCase().includes('restriction')
}

function notSupported(what: string, flags: GlobalFlags): void {
  if (flags.json) output({ ok: false, unsupported: true, what }, flags)
  else console.log(`⚠ ${what} isn't supported by the active device (spotifyd doesn't implement it over Spotify Connect).`)
}

async function musicDevices(flags: GlobalFlags): Promise<void> {
  const r = await hubFetch<{ devices: Snapshot['devices'] }>('/spotify/devices')
  if (flags.json) return output(r, flags)
  if (!r.devices.length) {
    console.log('No devices available (is spotifyd running + woken?).')
    return
  }
  for (const d of r.devices) {
    console.log(`${d.isActive ? '●' : '○'} ${d.name}${d.volumePercent != null ? ` (🔊${d.volumePercent})` : ''}`)
  }
}

async function musicTransfer(args: string[], flags: GlobalFlags): Promise<void> {
  const arg = args.find((a) => !a.startsWith('--'))
  if (!arg) return exitWithError('USAGE', 'Usage: con music transfer <device name or id>', flags)
  const r = await hubFetch<{ devices: Snapshot['devices'] }>('/spotify/devices')
  const match =
    r.devices.find((d) => d.id === arg) ??
    r.devices.find((d) => d.name.toLowerCase().includes(arg.toLowerCase()))
  if (!match?.id) return exitWithError('USAGE', `No device matching "${arg}"`, flags)
  await hubFetch('/spotify/transfer', { method: 'POST', body: { deviceId: match.id, play: true } })
  output({ ok: true, device: match.name }, flags)
}

async function musicSearch(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const q = args.find((a) => !a.startsWith('--')) ?? opts.q
  if (!q) return exitWithError('USAGE', 'Usage: con music search "<query>"', flags)
  const r = await hubFetch<{ tracks: Track[] }>('/spotify/search', { params: { q, limit: opts.limit ?? '8' } })
  if (flags.json) return output(r, flags)
  for (const t of r.tracks ?? []) console.log(`${t.name} — ${t.artists}  ${t.uri}`)
}

async function musicQueue(args: string[], flags: GlobalFlags): Promise<void> {
  const arg = args.find((a) => !a.startsWith('--'))
  if (!arg) return exitWithError('USAGE', 'Usage: con music queue <uri or query>', flags)
  let uri = arg
  if (!arg.startsWith('spotify:')) {
    const r = await hubFetch<{ tracks: Track[] }>('/spotify/search', { params: { q: arg, limit: '1' } })
    const track = r.tracks?.[0]
    if (!track) return exitWithError('USAGE', `No track found for "${arg}"`, flags)
    uri = track.uri
  }
  await hubFetch('/spotify/queue', { method: 'POST', body: { uri } })
  output({ ok: true, queued: uri }, flags)
}

async function musicLike(like: boolean, flags: GlobalFlags): Promise<void> {
  const snap = await getSnapshot()
  const id = snap.item?.id
  if (!id) return exitWithError('USAGE', 'No track currently playing', flags)
  await hubFetch(like ? '/spotify/save' : '/spotify/unsave', { method: 'POST', body: { ids: [id] } })
  output({ ok: true, liked: like, track: snap.item?.name }, flags)
}
