// ============================================================================
// Matrix M0 — safety-net room-key backup store
//
// The browser's OlmMachine holds Megolm room keys (the only way to decrypt
// historical encrypted messages). Before migrating Matrix to the hub, the
// browser exports its full room-key set and POSTs it here as a plain JSON
// snapshot. The hub writes it to ~/.config/console/matrix-key-backup.json
// alongside auth tokens — same trust boundary.
//
// On hub restart this is loaded into memory so GET /status can answer quickly.
// ============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type KeyBackupBlob = {
  userId: string
  deviceId: string
  exportedAt: number // ms epoch
  keyCount: number
  /** JSON string as exported by OlmMachine.exportRoomKeys() — store verbatim. */
  keys: string
}

export class KeyBackupStore {
  private current: KeyBackupBlob | null = null

  constructor(
    private readonly file: string,
    private readonly log: (msg: string) => void,
  ) {
    this.load()
  }

  save(blob: KeyBackupBlob): void {
    this.current = blob
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(blob))
      this.log(`[matrix-m0] saved key backup: ${blob.keyCount} keys for ${blob.userId}/${blob.deviceId}`)
    } catch (e) {
      this.log(`[matrix-m0] failed to save backup: ${e}`)
      throw e
    }
  }

  status(): { present: boolean; userId?: string; deviceId?: string; exportedAt?: number; keyCount?: number } {
    if (!this.current) return { present: false }
    return {
      present: true,
      userId: this.current.userId,
      deviceId: this.current.deviceId,
      exportedAt: this.current.exportedAt,
      keyCount: this.current.keyCount,
    }
  }

  /** Full blob (for restore into hub OlmMachine in M1). */
  get(): KeyBackupBlob | null {
    return this.current
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        this.current = JSON.parse(readFileSync(this.file, 'utf8')) as KeyBackupBlob
        this.log(`[matrix-m0] loaded key backup: ${this.current.keyCount} keys`)
      }
    } catch (e) {
      this.log(`[matrix-m0] failed to load backup: ${e}`)
    }
  }
}
