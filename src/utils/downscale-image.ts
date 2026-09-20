/** Downscale an image blob to maxDim px on the long edge, JPEG q0.85.
 *  GIFs and images already within the cap pass through untouched. */
export async function downscaleImage(blob: Blob, maxDim = 2000): Promise<Blob> {
  if (blob.type === 'image/gif') return blob
  try {
    const bmp = await createImageBitmap(blob)
    if (Math.max(bmp.width, bmp.height) <= maxDim) { bmp.close(); return blob }
    const scale = maxDim / Math.max(bmp.width, bmp.height)
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return out ?? blob
  } catch {
    return blob
  }
}
