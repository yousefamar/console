import { db } from '@/db'
import { getAttachment } from '@/gmail/api'
import type { AttachmentMeta } from '@/gmail/types'

// In-memory blob URL cache for quick access
const blobUrlCache = new Map<string, string>()

function base64UrlToBlob(data: string, mimeType: string): Blob {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

// Get a blob URL for an attachment (from cache or DB)
export async function getAttachmentBlobUrl(
  messageId: string,
  attachment: AttachmentMeta,
): Promise<string | null> {
  const key = `${messageId}:${attachment.attachmentId}`

  // Check in-memory cache
  if (blobUrlCache.has(key)) return blobUrlCache.get(key)!

  // Check IndexedDB
  const stored = await db.attachmentData.get(attachment.attachmentId)
  if (stored) {
    const url = URL.createObjectURL(stored.data)
    blobUrlCache.set(key, url)
    return url
  }

  // Fetch from hub
  try {
    const data = await getAttachment(messageId, attachment.attachmentId)
    const blob = base64UrlToBlob(data, attachment.mimeType)

    // Store in IndexedDB
    await db.attachmentData.put({
      attachmentId: attachment.attachmentId,
      messageId,
      data: blob,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
    })

    const url = URL.createObjectURL(blob)
    blobUrlCache.set(key, url)
    return url
  } catch {
    return null
  }
}

// Get raw blob for an attachment (for forwarding/downloading)
export async function getAttachmentBlob(
  messageId: string,
  attachment: AttachmentMeta,
): Promise<Blob | null> {
  // Check IndexedDB first
  const stored = await db.attachmentData.get(attachment.attachmentId)
  if (stored) return stored.data

  // Fetch from hub
  try {
    const data = await getAttachment(messageId, attachment.attachmentId)
    const blob = base64UrlToBlob(data, attachment.mimeType)

    await db.attachmentData.put({
      attachmentId: attachment.attachmentId,
      messageId,
      data: blob,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
    })

    return blob
  } catch {
    return null
  }
}

// Preload all attachments for inbox threads (call after email preload)
let preloadAbort: AbortController | null = null

export async function preloadAttachments(): Promise<void> {
  if (preloadAbort) preloadAbort.abort()
  preloadAbort = new AbortController()
  const signal = preloadAbort.signal

  const threads = await db.threads
    .filter((t) => t.labelIds.includes('INBOX') && !t.snoozedUntil)
    .toArray()

  for (const thread of threads) {
    if (signal.aborted) return

    const messages = await db.messages.where('threadId').equals(thread.id).toArray()
    for (const msg of messages) {
      if (signal.aborted) return
      if (!msg.attachments?.length) continue

      for (const att of msg.attachments) {
        if (signal.aborted) return

        // Skip if already cached
        const exists = await db.attachmentData.get(att.attachmentId)
        if (exists) continue

        try {
          const data = await getAttachment(msg.id, att.attachmentId)
          const blob = base64UrlToBlob(data, att.mimeType)
          await db.attachmentData.put({
            attachmentId: att.attachmentId,
            messageId: msg.id,
            data: blob,
            mimeType: att.mimeType,
            filename: att.filename,
          })
        } catch {
          // Skip failed attachments
        }
      }
    }

    // Yield between threads
    await new Promise((r) => setTimeout(r, 0))
  }
}

// Evict attachment data for a thread's messages
export async function evictThreadAttachments(threadId: string): Promise<void> {
  const messages = await db.messages.where('threadId').equals(threadId).toArray()
  for (const msg of messages) {
    // Revoke blob URLs
    if (msg.attachments) {
      for (const att of msg.attachments) {
        const key = `${msg.id}:${att.attachmentId}`
        const url = blobUrlCache.get(key)
        if (url) {
          URL.revokeObjectURL(url)
          blobUrlCache.delete(key)
        }
      }
    }
  }

  // Delete from DB
  const messageIds = messages.map((m) => m.id)
  if (messageIds.length > 0) {
    await db.attachmentData.where('messageId').anyOf(messageIds).delete()
  }
}

// Resolve CID references in HTML with blob URLs
export async function resolveCidReferences(
  messageId: string,
  html: string,
  attachments: AttachmentMeta[],
): Promise<string> {
  const cidAttachments = attachments.filter((a) => a.contentId)
  if (cidAttachments.length === 0) return html

  let resolved = html
  for (const att of cidAttachments) {
    const url = await getAttachmentBlobUrl(messageId, att)
    if (url && att.contentId) {
      // Replace cid:xxx references
      resolved = resolved.replace(
        new RegExp(`cid:${att.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'),
        url,
      )
    }
  }
  return resolved
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
