// ============================================================================
// Message archive — append-only, hub-owned record of every decrypted chat
// event the hub has ever seen. The foundation of Console's soft-delete-only
// guarantee: the homeserver strips redacted events (that's Matrix), but by
// the time a redaction arrives the original has already been archived here,
// and its media rescued to disk. NOTHING in this module deletes anything —
// there is deliberately no remove/prune/compact API.
//
// Layout under ~/.config/console/chat-archive/:
//   events/<sha1(roomId)>.ndjson   — one JSON line per archived event
//                                    (appends may duplicate; readers dedup
//                                    by event_id keeping the FIRST record,
//                                    which is the pre-redaction one)
//   media/<sha1(eventId)>.bin      — decrypted attachment bytes, written
//                                    when a redaction hits a media event
//                                    (blobs outlive event redaction on
//                                    Beeper, so rescue-at-redaction works;
//                                    an optional eager mode can be added
//                                    later if that ever stops holding)
// ============================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, createDecipheriv } from 'node:crypto'

export interface ArchivedEvent {
  event_id: string
  room_id: string
  sender?: string
  origin_server_ts?: number
  type: string
  content: Record<string, unknown>
  /** Set when a redaction was observed for this event. */
  redactedAt?: number
  redactedBy?: string
  /** Relative media filename under media/ once rescued. */
  mediaFile?: string
  mediaMimeType?: string
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function b64decode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export class MessageArchive {
  private readonly eventsDir: string
  private readonly mediaDir: string
  /** roomId → Set of archived event ids (loaded lazily per room). */
  private readonly seen = new Map<string, Set<string>>()

  constructor(
    private readonly baseDir: string,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.eventsDir = join(baseDir, 'events')
    this.mediaDir = join(baseDir, 'media')
    mkdirSync(this.eventsDir, { recursive: true })
    mkdirSync(this.mediaDir, { recursive: true })
  }

  private roomFile(roomId: string): string {
    return join(this.eventsDir, `${sha1(roomId)}.ndjson`)
  }

  private loadSeen(roomId: string): Set<string> {
    let set = this.seen.get(roomId)
    if (set) return set
    set = new Set()
    const file = this.roomFile(roomId)
    if (existsSync(file)) {
      try {
        for (const line of readFileSync(file, 'utf-8').split('\n')) {
          if (!line) continue
          try {
            const rec = JSON.parse(line) as ArchivedEvent
            if (rec.event_id) set.add(rec.event_id)
          } catch { /* skip corrupt line */ }
        }
      } catch { /* unreadable file — treat as empty */ }
    }
    this.seen.set(roomId, set)
    return set
  }

  /** Archive a batch of decrypted events for a room. Message-bearing types
   *  only; state/ephemeral noise is skipped. Idempotent per event_id. */
  archiveEvents(roomId: string, events: Array<Record<string, unknown>>): number {
    const seen = this.loadSeen(roomId)
    let appended = 0
    let out = ''
    for (const ev of events) {
      const id = ev.event_id as string | undefined
      const type = ev.type as string | undefined
      if (!id || !type) continue
      // Archive real content: messages (decrypted), stickers, encrypted
      // events the hub couldn't decrypt (ciphertext may become decryptable
      // later after a key restore — archive preserves the chance).
      if (type !== 'm.room.message' && type !== 'm.sticker' && type !== 'm.room.encrypted') continue
      if (seen.has(id)) continue
      // Redaction tombstones (encrypted with no ciphertext) carry nothing
      // worth archiving — and must NOT claim the event_id slot, else the
      // real content that arrived earlier would never... (it was first, so
      // it holds the slot; a tombstone-first arrival means content is
      // already gone server-side and there is nothing to save).
      const content = (ev.content ?? {}) as Record<string, unknown>
      const rec: ArchivedEvent = {
        event_id: id,
        room_id: roomId,
        sender: ev.sender as string | undefined,
        origin_server_ts: ev.origin_server_ts as number | undefined,
        type,
        content,
      }
      out += JSON.stringify(rec) + '\n'
      seen.add(id)
      appended++
    }
    if (out) appendFileSync(this.roomFile(roomId), out)
    return appended
  }

  /** Look up the FIRST archived record for an event (pre-redaction copy). */
  getEvent(roomId: string, eventId: string): ArchivedEvent | undefined {
    const file = this.roomFile(roomId)
    if (!existsSync(file)) return undefined
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line) continue
        try {
          const rec = JSON.parse(line) as ArchivedEvent
          if (rec.event_id === eventId && (rec.type === 'm.room.message' || rec.type === 'm.sticker' || rec.type === 'm.room.encrypted')) {
            // Merge any later media-rescue annotation (appended as a
            // separate record with the same event_id + mediaFile set).
            const annotated = this.findAnnotation(file, eventId)
            return annotated ? { ...rec, ...annotated } : rec
          }
        } catch { /* skip */ }
      }
    } catch { /* unreadable */ }
    return undefined
  }

  private findAnnotation(file: string, eventId: string): Partial<ArchivedEvent> | undefined {
    let result: Partial<ArchivedEvent> | undefined
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (!line || !line.includes('"_annotation":true')) continue
      try {
        const rec = JSON.parse(line) as Partial<ArchivedEvent> & { _annotation?: boolean }
        if (rec.event_id === eventId) result = rec
      } catch { /* skip */ }
    }
    return result
  }

  /** Record that an event was redacted + (if media) rescue the decrypted
   *  bytes to disk. Appends an annotation record — the original line is
   *  never touched. Returns the media filename if rescued. */
  async recordRedaction(
    roomId: string,
    eventId: string,
    redactedBy: string | undefined,
    fetchMedia: (mxcUrl: string) => Promise<Buffer | undefined>,
  ): Promise<string | undefined> {
    const original = this.getEvent(roomId, eventId)
    if (!original) return undefined
    let mediaFile: string | undefined
    let mediaMimeType: string | undefined
    // Rescue attachment bytes if the original carried media and we haven't
    // already rescued it.
    if (!original.mediaFile) {
      try {
        const rescued = await this.rescueMedia(original, fetchMedia)
        if (rescued) { mediaFile = rescued.file; mediaMimeType = rescued.mime }
      } catch (e) {
        this.log(`[archive] media rescue failed for ${eventId}: ${(e as Error).message}`)
      }
    }
    const annotation = {
      _annotation: true,
      event_id: eventId,
      redactedAt: Date.now(),
      redactedBy,
      ...(mediaFile ? { mediaFile, mediaMimeType } : {}),
    }
    appendFileSync(this.roomFile(roomId), JSON.stringify(annotation) + '\n')
    return mediaFile
  }

  private async rescueMedia(
    ev: ArchivedEvent,
    fetchMedia: (mxcUrl: string) => Promise<Buffer | undefined>,
  ): Promise<{ file: string; mime: string } | undefined> {
    const content = ev.content
    const encFile = content.file as { url?: string; key?: { k?: string }; iv?: string; hashes?: { sha256?: string } } | undefined
    const plainUrl = content.url as string | undefined
    const info = content.info as { mimetype?: string } | undefined
    const mime = info?.mimetype ?? 'application/octet-stream'

    if (encFile?.url && encFile.key?.k && encFile.iv) {
      const blob = await fetchMedia(encFile.url)
      if (!blob) return undefined
      // Verify hash if present, then AES-256-CTR decrypt per the Matrix
      // encrypted-attachment spec.
      if (encFile.hashes?.sha256) {
        const want = b64decode(encFile.hashes.sha256)
        const got = createHash('sha256').update(blob).digest()
        if (!want.equals(got)) {
          this.log(`[archive] media hash mismatch for ${ev.event_id} — storing encrypted blob as-is`)
          const file = `${sha1(ev.event_id)}.enc`
          writeFileSync(join(this.mediaDir, file), blob)
          return { file, mime: 'application/octet-stream' }
        }
      }
      const key = b64decode(encFile.key.k)
      const iv = b64decode(encFile.iv)
      const decipher = createDecipheriv('aes-256-ctr', key, iv)
      const plain = Buffer.concat([decipher.update(blob), decipher.final()])
      const file = `${sha1(ev.event_id)}.bin`
      writeFileSync(join(this.mediaDir, file), plain)
      return { file, mime }
    }
    if (plainUrl?.startsWith('mxc://')) {
      const blob = await fetchMedia(plainUrl)
      if (!blob) return undefined
      const file = `${sha1(ev.event_id)}.bin`
      writeFileSync(join(this.mediaDir, file), blob)
      return { file, mime }
    }
    return undefined
  }

  /** Absolute path of a rescued media file (for the serving route). */
  mediaPath(file: string): string | undefined {
    // Filenames are sha1 hex + fixed extension — reject anything else so a
    // crafted request can't traverse out of the media dir.
    if (!/^[0-9a-f]{40}\.(bin|enc)$/.test(file)) return undefined
    const p = join(this.mediaDir, file)
    return existsSync(p) ? p : undefined
  }
}
