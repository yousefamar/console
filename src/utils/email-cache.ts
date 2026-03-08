import { db } from '@/db'
import { sanitizeHtml, buildDarkModeEmailCss } from './email'
import { resolveCidReferences } from './attachment-cache'

interface CacheEntry {
  lightUrl: string
  darkUrl: string
  height: number | null
}

const cache = new Map<string, CacheEntry>()
let preloadAbort: AbortController | null = null

function buildDoc(html: string, dark: boolean): string {
  const sanitized = sanitizeHtml(html)
  const darkCss = dark ? `<style>${buildDarkModeEmailCss()}</style>` : ''
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="only light">
  <meta name="supported-color-schemes" content="light only">
  ${darkCss}
  <style>
    :root { color-scheme: only light; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      overflow-wrap: break-word;
      background: #fff;
    }
    a { color: #3b82f6; }
    img { max-width: 100%; height: auto; }
    blockquote {
      margin: 0.5em 0;
      padding-left: 0.75em;
      border-left: 2px solid #ccc;
    }
  </style>
</head>
<body>${sanitized}</body>
</html>`
}

function createBlobUrl(html: string, dark: boolean): string {
  const doc = buildDoc(html, dark)
  const blob = new Blob([doc], { type: 'text/html' })
  return URL.createObjectURL(blob)
}

export function getCached(messageId: string): CacheEntry | undefined {
  return cache.get(messageId)
}

export function updateHeight(messageId: string, height: number): void {
  const entry = cache.get(messageId)
  if (entry) entry.height = height
}

async function cacheMessageWithCid(msg: { id: string; bodyHtml: string; attachments?: { attachmentId: string; filename: string; mimeType: string; size: number; contentId?: string }[] }): Promise<void> {
  if (cache.has(msg.id)) return

  let html = msg.bodyHtml
  if (msg.attachments?.some((a) => a.contentId)) {
    try {
      html = await resolveCidReferences(msg.id, html, msg.attachments)
    } catch {
      // Fall back to unresolved HTML
    }
  }

  cache.set(msg.id, {
    lightUrl: createBlobUrl(html, false),
    darkUrl: createBlobUrl(html, true),
    height: null,
  })
}

export async function preloadThread(threadId: string): Promise<void> {
  const messages = await db.messages.where('threadId').equals(threadId).toArray()
  for (const msg of messages) {
    await cacheMessageWithCid(msg)
  }
}

export async function preloadAllInbox(): Promise<void> {
  // Abort any previous preload
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
      await cacheMessageWithCid(msg)
    }
    // Yield to main thread between threads
    await new Promise((r) => setTimeout(r, 0))
  }
}

export function evictAll(): void {
  for (const [id, entry] of cache) {
    URL.revokeObjectURL(entry.lightUrl)
    URL.revokeObjectURL(entry.darkUrl)
    cache.delete(id)
  }
}

export function evictMessage(messageId: string): void {
  const entry = cache.get(messageId)
  if (entry) {
    URL.revokeObjectURL(entry.lightUrl)
    URL.revokeObjectURL(entry.darkUrl)
    cache.delete(messageId)
  }
}

export function cacheSize(): number {
  return cache.size
}
