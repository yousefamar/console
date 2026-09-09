// Client port of server/src/calendar-links.ts — keep the key layout in sync
// (the board.ts precedent). Private links live on YOUR copy of a Google event
// as extendedProperties.private `console.link.<i>` + marker `console.links=1`.

export const LINK_KEY_PREFIX = 'console.link.'

export interface EventWithProps {
  extendedProperties?: { private?: Record<string, string> | null } | null
}

export function readLinks(event: EventWithProps | null | undefined): string[] {
  const priv = event?.extendedProperties?.private ?? {}
  return Object.entries(priv)
    .filter(([k, v]) => k.startsWith(LINK_KEY_PREFIX) && typeof v === 'string' && v.length > 0)
    .map(([k, v]) => [Number(k.slice(LINK_KEY_PREFIX.length)), v] as const)
    .filter(([i]) => Number.isInteger(i) && i >= 0)
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
}

/** Extensions the hub's media bridge (`/agents/local-file`) will serve. */
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|pdf|mp4|webm|mov)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

export type LinkKind =
  | { kind: 'url'; label: string; href: string }
  /** A file inside the vault — opens in Spaces Docs, peekable via /notes/file/. */
  | { kind: 'vault'; label: string; vaultPath: string }
  /** A local file the media bridge can serve (image/pdf/video). */
  | { kind: 'media'; label: string; path: string; image: boolean }
  /** Anything else — shown as a path with copy; nothing to open in the browser. */
  | { kind: 'file'; label: string; path: string }

/** Classify a stored link. `vaultRoot` is the absolute vault dir (hub
 *  `/notes/vault-path`); without it, vault files fall through to `file`. */
export function classifyLink(link: string, vaultRoot: string | null): LinkKind {
  const l = link.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(l)) {
    let label = l
    try { const u = new URL(l); label = u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '') } catch { /* keep raw */ }
    return { kind: 'url', label, href: l }
  }
  const base = l.split('/').filter(Boolean).pop() ?? l
  if (vaultRoot) {
    const root = vaultRoot.replace(/\/+$/, '') + '/'
    if (l.startsWith(root)) return { kind: 'vault', label: base, vaultPath: l.slice(root.length) }
  }
  // Vault-relative shorthand (`projects/x/note.md`) — not absolute, ends in .md.
  if (!l.startsWith('/') && !l.startsWith('~') && /\.md$/i.test(l)) return { kind: 'vault', label: base, vaultPath: l }
  if (MEDIA_EXT.test(l)) return { kind: 'media', label: base, path: l, image: IMAGE_EXT.test(l) }
  return { kind: 'file', label: base, path: l }
}
