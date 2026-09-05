// Card image attachments — shared plumbing for the board UI.
//
// An image on a card IS a markdown image detail line (`![img](board/x.png)`)
// under the card, path relative to the vault's sibling assets dir and served
// by the hub at /notes/asset/<path>. The UI renders those lines as thumbnails
// instead of text; pasting into a card editor uploads the blob and appends
// the line.
//
// New uploads go under `board/`, never `images/`: the website publishes
// assets/ by a dir allow-list, so an unlisted dir is private by construction
// (card screenshots in images/ went live on yousefamar.com — opsec rem #65).
// Older `images/card-*` lines still render; the hub serves any assets path.

import { getHubUrl } from '@/hub'

export const CARD_ASSET_DIR = 'board'

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

/** Upload a pasted image blob to the sibling assets dir under `board/`.
 *  Returns the asset-relative path. */
export async function uploadCardImage(blob: Blob): Promise<string | null> {
  const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  const filename = `card-${Date.now()}.${ext}`
  const assetPath = `${CARD_ASSET_DIR}/${filename}`
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
