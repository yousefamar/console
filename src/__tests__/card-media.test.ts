// The gate for files picked into a board card must agree with the hub's
// attach route (server/src/kanban/board-ops.ts): png/jpg/gif/webp stills,
// mp4/webm clips, 20 MB ceiling.
import { describe, it, expect } from 'vitest'
import { cardAssetExt, classifyCardMedia, MAX_CARD_MEDIA_BYTES } from '@/kanban/card-media'

describe('card media gate', () => {
  it('maps storable MIME types to the asset extension the hub expects', () => {
    expect(cardAssetExt('image/png')).toBe('png')
    expect(cardAssetExt('image/jpeg')).toBe('jpg')
    expect(cardAssetExt('image/gif')).toBe('gif')
    expect(cardAssetExt('image/webp')).toBe('webp')
    expect(cardAssetExt('video/mp4')).toBe('mp4')
    expect(cardAssetExt('video/webm; codecs=vp9')).toBe('webm')
    expect(cardAssetExt('image/svg+xml')).toBeNull()
    expect(cardAssetExt('video/quicktime')).toBeNull()
    expect(cardAssetExt('')).toBeNull()
  })

  it('lets any image through to the preparer (it re-encodes and re-checks)', () => {
    expect(classifyCardMedia('IMG_0001.heic', 'image/heic', 9_000_000)).toEqual({ kind: 'image' })
    expect(classifyCardMedia('shot.png', 'image/png', 100)).toEqual({ kind: 'image' })
  })

  it('accepts only mp4/webm clips under the cap', () => {
    expect(classifyCardMedia('clip.webm', 'video/webm', 1024)).toEqual({ kind: 'clip', ext: 'webm' })
    expect(classifyCardMedia('clip.mp4', 'video/mp4', MAX_CARD_MEDIA_BYTES)).toEqual({ kind: 'clip', ext: 'mp4' })
    expect(classifyCardMedia('clip.mov', 'video/quicktime', 1024)).toMatchObject({ kind: 'reject', reason: 'clip.mov: only mp4 or webm clips' })
    expect(classifyCardMedia('big.mp4', 'video/mp4', MAX_CARD_MEDIA_BYTES + 1)).toMatchObject({ kind: 'reject', reason: 'big.mp4: 20.0 MB, cap 20.0 MB' })
  })

  it('rejects anything that is neither', () => {
    expect(classifyCardMedia('notes.pdf', 'application/pdf', 10)).toMatchObject({ kind: 'reject', reason: 'notes.pdf: not an image or video' })
  })
})
