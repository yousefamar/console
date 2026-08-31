// Client-side frontmatter parse/stamp — keep the parsing logic in sync with
// server/src/blog.ts (parseFrontmatter / stampFrontmatter). Ported rather than
// shared because the SPA and hub are separate builds and it's ~80 lines.
//
// One extension over the server version: stampFrontmatter accepts string[]
// values (for tags) and serializes them as a YAML block list, replacing any
// existing scalar / inline-array / block-list form.

export interface Frontmatter {
  title?: string
  date?: string
  post?: boolean
  public?: boolean
  listed?: boolean
  log?: boolean
  project?: string
  status?: string
  tags?: string[]
}

// A plain (unquoted) YAML scalar can't hold everything a title can. The
// classic break: `title: Foo: bar` is a hard parse error ("incomplete explicit
// mapping pair"), which fails the Eleventy build for that post — so EVERY
// write path must go through yamlScalar(). Double-quoted style matches the
// convention already in the vault.
export function yamlScalar(value: string | boolean | number): string {
  if (typeof value !== 'string') return String(value)
  if (!needsYamlQuoting(value)) return value
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function needsYamlQuoting(s: string): boolean {
  if (s === '') return true
  if (s !== s.trim()) return true                        // leading/trailing space is dropped
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true     // YAML indicator char
  if (/:\s/.test(s) || s.endsWith(':')) return true      // reads as a nested mapping
  if (/\s#/.test(s)) return true                         // reads as a trailing comment
  if (/[\n\r\t]/.test(s)) return true
  // Would come back as a non-string
  if (/^(?:true|false|yes|no|on|off|null|~)$/i.test(s)) return true
  if (/^[+-]?(?:\d[\d_]*)?(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(s)) return true
  if (/^0[xob]/i.test(s)) return true
  return false
}

/**
 * Inverse of yamlScalar. Only strips a MATCHED quote pair — a bare trailing
 * quote (`Bruteforcing tailnet "fun names"`) is content, not a delimiter, and
 * the old `/^["']|["']$/g` strip silently ate it.
 */
export function unquoteYamlScalar(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\/nrt])/g, (_, c: string) => (
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
    ))
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  return v
}

function isQuoted(v: string): boolean {
  return v.length >= 2
    && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
}

export function parseFrontmatter(content: string): { fm: Frontmatter; body: string; raw: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: content, raw: '' }
  const raw = m[1]!
  const body = m[2] ?? ''
  const fm: Frontmatter = {}
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!kv) continue
    const [, key, valRaw] = kv
    const val = valRaw!.trim()
    if (key === 'tags') {
      // Three forms in the wild:
      //   tags: foo            (scalar — single tag or comma/space-separated list)
      //   tags: [foo, bar]     (inline array)
      //   tags:\n  - foo\n     (block list)
      if (val.startsWith('[') && val.endsWith(']')) {
        fm.tags = val.slice(1, -1).split(',').map((s) => unquoteYamlScalar(s.trim())).filter(Boolean)
      } else if (val === '' || val === '[]') {
        const tags: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j]!.match(/^\s*-\s+(.+?)\s*$/)
          if (!item) break
          tags.push(unquoteYamlScalar(item[1]!))
        }
        if (tags.length) fm.tags = tags
      } else if (isQuoted(val)) {
        // A quoted scalar is ONE tag, commas and all.
        const only = unquoteYamlScalar(val)
        if (only) fm.tags = [only]
      } else {
        const parts = (val.includes(',') ? val.split(',') : val.split(/\s+/))
          .map((s) => s.trim())
          .filter(Boolean)
        if (parts.length) fm.tags = parts
      }
      continue
    }
    if (val === '') continue
    // Bool coercion only for UNQUOTED values — `title: "true"` is the string.
    if (isQuoted(val)) (fm as Record<string, unknown>)[key!] = unquoteYamlScalar(val)
    else if (val === 'true') (fm as Record<string, unknown>)[key!] = true
    else if (val === 'false') (fm as Record<string, unknown>)[key!] = false
    else (fm as Record<string, unknown>)[key!] = val
  }
  return { fm, body, raw }
}

/**
 * Stamp keys into frontmatter, replacing existing lines or appending.
 * Array values (tags) serialize as a block list and replace ANY existing
 * form of the key (scalar / inline / block). Returns full file content.
 */
export function stampFrontmatter(
  content: string,
  updates: Record<string, string | boolean | string[]>,
): string {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  let raw = m ? m[1]! : ''
  const body = m ? (m[2] ?? '') : content
  let lines = raw.length ? raw.split('\n') : []

  for (const [k, v] of Object.entries(updates)) {
    // Remove any existing occurrence of the key. For block-list keys this
    // also removes the following `- item` lines.
    const idx = lines.findIndex((l) => l.match(new RegExp(`^${k}:`)))
    let insertAt = lines.length
    if (idx >= 0) {
      let end = idx + 1
      while (end < lines.length && lines[end]!.match(/^\s*-\s+/)) end++
      lines.splice(idx, end - idx)
      insertAt = idx
    }

    if (Array.isArray(v)) {
      const block = v.length ? [`${k}:`, ...v.map((item) => `  - ${yamlScalar(item)}`)] : [`${k}: `]
      lines.splice(insertAt, 0, ...block)
    } else {
      lines.splice(insertAt, 0, `${k}: ${yamlScalar(v)}`)
    }
  }
  raw = lines.join('\n')
  return `---\n${raw}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`
}

/**
 * The byte range of the frontmatter block (including both `---` fences and
 * the trailing newline) in `content`, or null when there is none. Used to
 * surgically replace frontmatter via a CM6 transaction without touching the
 * body (preserves cursor + undo granularity).
 */
export function frontmatterRange(content: string): { from: number; to: number } | null {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/)
  if (!m) return null
  return { from: 0, to: m[0]!.length }
}

/**
 * Public URL for a published post. Posts live in log/<name>.md or
 * projects/<slug>/log/<name>.md; both publish at /memo/log/<name>/.
 */
export function permalinkForLogPath(path: string): string | null {
  const m = path.match(/^projects\/[^/]+\/log\/([^/]+)\.md$/) ?? path.match(/^log\/([^/]+)\.md$/)
  if (!m) return null
  return `https://yousefamar.com/memo/log/${m[1]}/`
}

export const DRAFTS_DIR = 'log/drafts'
export const LEGACY_DRAFTS_DIR = 'scratch/blog-drafts'
export const LOG_DIR = 'log'

export function isDraftPath(path: string | null | undefined): boolean {
  return !!path && (
    path.startsWith(`${DRAFTS_DIR}/`)
    || path.startsWith(`${LEGACY_DRAFTS_DIR}/`)
    || /^projects\/[^/]+\/log\/drafts\/[^/]+\.md$/.test(path)
  )
}

/** Project slug implied by a draft's location, or null for unhomed drafts. */
export function projectForDraftPath(path: string | null | undefined): string | null {
  return path?.match(/^projects\/([^/]+)\/log\/drafts\/[^/]+\.md$/)?.[1] ?? null
}

export function isPublishedPath(path: string | null | undefined): boolean {
  return !!path && /^(?:projects\/[^/]+\/)?log\/[^/]+\.md$/.test(path)
}
