// Card image attachments — shared plumbing for the board UI.
//
// An image on a card IS a markdown image detail line (`![img](images/x.png)`)
// under the card, path relative to the vault's sibling assets dir (the
// pasteImage convention) and served by the hub at /notes/asset/<path>. The
// UI renders those lines as thumbnails instead of text; pasting into a card
// editor uploads the blob and appends the line.

import { getHubUrl } from '@/hub'

export const IMAGE_LINE_RE = /^!\[[^\]]*\]\(([^)]+)\)$/

export function isImageLine(line: string): boolean {
  return IMAGE_LINE_RE.test(line.trim())
}

export function imagePathOf(line: string): string | null {
  return line.trim().match(IMAGE_LINE_RE)?.[1] ?? null
}

export function imageLineFor(assetPath: string): string {
  return `![img](${assetPath})`
}

/** Upload a pasted image blob to the sibling assets dir (same convention as
 *  the notes editor's pasteImage). Returns the asset-relative path. */
export async function uploadCardImage(blob: Blob): Promise<string | null> {
  const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  const filename = `card-${Date.now()}.${ext}`
  const assetPath = `images/${filename}`
  try {
    const res = await fetch(`${getHubUrl()}/notes/asset/${encodeURIComponent(assetPath)}`, {
      method: 'PUT',
      body: blob,
    })
    return res.ok ? assetPath : null
  } catch {
    return null
  }
}

/** Extract image blobs from a paste event (returns [] for text-only pastes). */
export function imagesFromPaste(e: React.ClipboardEvent): Blob[] {
  const out: Blob[] = []
  for (const item of e.clipboardData?.items ?? []) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

// Blob-URL cache so thumbnails don't refetch on every render. Keyed by asset
// path; entries live for the page lifetime (small images, bounded set).
const urlCache = new Map<string, Promise<string | null>>()

export function assetBlobUrl(assetPath: string): Promise<string | null> {
  let p = urlCache.get(assetPath)
  if (!p) {
    p = fetch(`${getHubUrl()}/notes/asset/${encodeURIComponent(assetPath)}`)
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null)
    urlCache.set(assetPath, p)
  }
  return p
}
