// RingStore — files every Pebble Index 01 webhook delivery away for
// posterity: the M4A recording as-is plus a JSON sidecar (ring transcript,
// hub STT fallback, routing outcome). Append-only by design — like the chat
// MessageArchive there is deliberately NO delete/prune API.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { RingCommand } from './router.js'

export interface RingRecording {
  id: string
  /** Ring-reported capture time (ms epoch), or receivedAt when absent. */
  recordedAt: number
  receivedAt: number
  client: string | null
  /** Transcript used for routing, and where it came from. */
  transcription: string | null
  transcriptionSource: 'ring' | 'hub-stt' | null
  audio: { path: string; bytes: number; contentType: string } | null
  /** Set once routing ran; absent for a pure archive (nothing to route). */
  route?: {
    command: RingCommand
    /** 'rule' = deterministic match, 'llm' = fallback classifier, 'default' =
     *  unmatched → fallback agent, 'none' = unmatched and no fallback. */
    via: 'rule' | 'llm' | 'default' | 'none'
    rule?: string
    ok: boolean
    detail?: string
  }
}

export class RingStore {
  private readonly dir: string
  private readonly recordingsDir: string

  constructor(configDir: string) {
    this.dir = join(configDir, 'ring')
    this.recordingsDir = join(this.dir, 'recordings')
    mkdirSync(this.recordingsDir, { recursive: true })
  }

  /** Sortable, filesystem-safe id: `2026-09-02T10-15-30.123Z-ab12`. */
  mintId(recordedAt: number): string {
    const iso = new Date(recordedAt).toISOString().replace(/:/g, '-')
    return `${iso}-${randomBytes(2).toString('hex')}`
  }

  save(rec: Omit<RingRecording, 'audio'> & { audio?: { data: Buffer; contentType: string } | null }): RingRecording {
    let audio: RingRecording['audio'] = null
    if (rec.audio && rec.audio.data.length) {
      const ext = rec.audio.contentType.includes('mp4') || rec.audio.contentType.includes('m4a') ? 'm4a' : 'bin'
      const path = join(this.recordingsDir, `${rec.id}.${ext}`)
      writeFileSync(path, rec.audio.data)
      audio = { path, bytes: rec.audio.data.length, contentType: rec.audio.contentType }
    }
    const { audio: _drop, ...rest } = rec
    const full: RingRecording = { ...rest, audio }
    this.writeMeta(full)
    return full
  }

  update(rec: RingRecording): void {
    this.writeMeta(rec)
  }

  get(id: string): RingRecording | null {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return null
    const p = join(this.recordingsDir, `${id}.json`)
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, 'utf8')) as RingRecording } catch { return null }
  }

  /** Newest first. */
  list(limit = 50): RingRecording[] {
    const ids = readdirSync(this.recordingsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
      .reverse()
      .slice(0, limit)
    return ids.map((id) => this.get(id)).filter((r): r is RingRecording => !!r)
  }

  count(): number {
    return readdirSync(this.recordingsDir).filter((f) => f.endsWith('.json')).length
  }

  audioPath(id: string): string | null {
    const rec = this.get(id)
    if (!rec?.audio) return null
    return existsSync(rec.audio.path) && statSync(rec.audio.path).isFile() ? rec.audio.path : null
  }

  private writeMeta(rec: RingRecording): void {
    this.writeAtomic(join(this.recordingsDir, `${rec.id}.json`), JSON.stringify(rec, null, 2))
  }

  private writeAtomic(path: string, content: string): void {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  }
}
