import { db, getMeta, setMeta } from '@/db'
import { getEvent } from './api'
import type { EncryptedFile } from './types'

const MIGRATION_KEY = 'backfill_media_v3'

// One-time migration: legacy rows saved before we persisted mediaUrl/encryptedFile.
// Only handles plaintext events now — encrypted legacy rows will be repopulated
// when the hub re-delivers them via pagination/sync (hub decrypts server-side).
export async function backfillMediaUrls(): Promise<void> {
  const done = await getMeta(MIGRATION_KEY)
  if (done) return

  const messages = await db.chatMessages
    .filter((m) => (m.type === 'image' || m.type === 'file' || m.type === 'audio') && !m.mediaUrl && !m.encryptedFile)
    .toArray()

  if (messages.length === 0) {
    await setMeta(MIGRATION_KEY, '1')
    return
  }

  let updated = 0
  for (const msg of messages) {
    try {
      const event = await getEvent(msg.roomId, msg.id)
      if (event.type === 'm.room.encrypted') continue
      const url = event.content.url as string | undefined
      const encryptedFile = event.content.file as EncryptedFile | undefined
      const update: Partial<Pick<typeof msg, 'mediaUrl' | 'encryptedFile'>> = {}
      if (url) update.mediaUrl = url
      if (encryptedFile) update.encryptedFile = encryptedFile
      if (Object.keys(update).length > 0) {
        await db.chatMessages.update(msg.id, update)
        updated++
      }
    } catch {
      // Event may be inaccessible — skip
    }
  }

  console.log(`[migration] Backfilled media for ${updated}/${messages.length} messages`)
  await setMeta(MIGRATION_KEY, '1')
}
