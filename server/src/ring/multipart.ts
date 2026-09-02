// Binary-safe multipart/form-data parser (pure, no I/O). The Pebble ring
// posts an M4A recording alongside text fields; the ad-hoc `toString('binary')
// .split()` approach used elsewhere would work but copies the whole body
// through a Latin-1 string — this walks Buffers directly.

export interface MultipartPart {
  name: string
  filename?: string
  contentType?: string
  data: Buffer
}

const CRLF2 = Buffer.from('\r\n\r\n')

export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const b = (m?.[1] ?? m?.[2])?.trim()
  return b || null
}

export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delim = Buffer.from(`--${boundary}`)
  const parts: MultipartPart[] = []
  let pos = body.indexOf(delim)
  while (pos !== -1) {
    pos += delim.length
    // Closing delimiter is `--<boundary>--`.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break
    // Skip the CRLF after the delimiter line.
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2
    const headerEnd = body.indexOf(CRLF2, pos)
    if (headerEnd === -1) break
    const headers = body.subarray(pos, headerEnd).toString('utf8')
    const next = body.indexOf(delim, headerEnd + 4)
    if (next === -1) break
    // Body runs to the CRLF that precedes the next delimiter.
    let dataEnd = next
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2
    const data = body.subarray(headerEnd + 4, dataEnd)
    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers)?.[1] ?? ''
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1] ?? /\bname=([^;\s]+)/i.exec(disp)?.[1]
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1]
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim()
    if (name !== undefined) parts.push({ name, filename, contentType, data: Buffer.from(data) })
    pos = next
  }
  return parts
}

/** Build a multipart body — used by tests and the `con ring say` simulator. */
export function buildMultipart(fields: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>, boundary = `----ring${Date.now()}`): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = []
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`
    if (f.filename) head += `; filename="${f.filename}"`
    head += '\r\n'
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`
    head += '\r\n'
    chunks.push(Buffer.from(head), Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}
