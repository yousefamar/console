// Pure gate for files picked into a board card (file picker / camera). No DOM,
// no hub — the async preparer in card-images.ts wraps it. Mirrors the hub's
// attach route (kanban/board-ops.ts): png/jpg/gif/webp stills, mp4/webm clips,
// 20 MB ceiling.

export const MAX_CARD_MEDIA_BYTES = 20 * 1024 * 1024

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** Asset extension for a MIME type the board can store, else null. */
export function cardAssetExt(mime: string): string | null {
  return EXT_BY_MIME[mime.split(';')[0]!.trim().toLowerCase()] ?? null
}

export type CardMediaClass =
  | { kind: 'image' }
  | { kind: 'clip'; ext: string }
  | { kind: 'reject'; reason: string }

/** Decide what a picked file may become BEFORE any bytes move. Images of any
 *  type pass here (the preparer downscales/re-encodes them and re-checks the
 *  result); clips must already be mp4/webm and under the cap. */
export function classifyCardMedia(name: string, type: string, size: number): CardMediaClass {
  if (type.startsWith('image/')) return { kind: 'image' }
  if (type.startsWith('video/')) {
    const ext = cardAssetExt(type)
    if (!ext) return { kind: 'reject', reason: `${name}: only mp4 or webm clips` }
    if (size > MAX_CARD_MEDIA_BYTES) return { kind: 'reject', reason: `${name}: ${formatMb(size)} MB, cap ${formatMb(MAX_CARD_MEDIA_BYTES)} MB` }
    return { kind: 'clip', ext }
  }
  return { kind: 'reject', reason: `${name}: not an image or video` }
}

export function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
