import { db, getMeta, setMeta } from '@/db'
import { getEvent } from './api'
import { decryptRoomEvent, isCryptoReady } from './crypto'
import type { EncryptedFile } from './types'

const MIGRATION_KEY = 'backfill_media_v3'

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

  console.log(`[migration] Backfilling media for ${messages.length} messages`)

  let updated = 0
  for (const msg of messages) {
    try {
      const event = await getEvent(msg.roomId, msg.id)

      let url: string | undefined
      let encryptedFile: EncryptedFile | undefined

      if (event.type === 'm.room.encrypted' && isCryptoReady()) {
        const decrypted = await decryptRoomEvent(event, msg.roomId)
        if (decrypted) {
          url = decrypted.content.url as string | undefined
          encryptedFile = decrypted.content.file as EncryptedFile | undefined
        }
      } else {
        url = event.content.url as string | undefined
        encryptedFile = event.content.file as EncryptedFile | undefined
      }

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
