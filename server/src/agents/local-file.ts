// Local-file media bridge — lets an agent transcript's `![x](/abs/path.png)`
// render inline in the SPA. Agents run as this user, so serving a local file
// to an authenticated client grants nothing the fleet doesn't already have;
// the normal auth wall gates the route. Media-extension whitelist + a CSP
// `sandbox` response header (set at the route) keep scriptable formats (svg,
// pdf) from running same-origin against the hub cookie.

import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

export const MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024

export function resolveLocalMedia(raw: string | null): { abs: string; contentType: string } | { error: string; status: number } {
  let p = (raw ?? '').trim()
  if (!p) return { error: 'path is required', status: 400 }
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1))
  if (!p.startsWith('/')) return { error: 'absolute paths only', status: 400 }
  const abs = resolve(p)
  const contentType = MEDIA_TYPES[extname(abs).toLowerCase()]
  if (!contentType) return { error: `unsupported media extension on "${abs}"`, status: 415 }
  return { abs, contentType }
}
