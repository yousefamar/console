// Line-level block segmentation for the transcript's markdown-lite renderer.
// Pure (no React) so it can be unit-tested in the node vitest environment.

export type ListItem = {
  /** Nesting depth: an item indented ≥2 columns past the previous item's marker nests under it. */
  depth: number
  ordered: boolean
  /** The written number of an ordered item (`3.` → 3). */
  num?: number
  /** `- [ ]` / `- [x]` task boxes; undefined for plain bullets. */
  checked?: boolean
  text: string
}

type ParsedListItem = Omit<ListItem, 'depth'> & { indent: number }

export type BlockSegment =
  | { kind: 'text'; lines: string[] }
  | { kind: 'table'; header: string; body: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: ListItem[] }

const TABLE_SEP_RE = /^\s*\|?\s*[-:]+[-| :]*$/
const QUOTE_RE = /^ {0,3}>(?: ?(.*))?$/
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
// `- item`, `* item`, `+ item`, `1. item`, `1) item`, optional `[ ]`/`[x]` task box.
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d{1,3})[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/

export function parseListItem(line: string): ParsedListItem | null {
  const m = line.match(LIST_RE)
  if (!m) return null
  const indent = m[1]!.replace(/\t/g, '  ').length
  return { indent, ordered: !!m[3], ...(m[3] ? { num: Number(m[3]) } : {}), checked: m[4] === undefined ? undefined : m[4] !== ' ', text: m[5] ?? '' }
}

/** Transcript text as the renderer should see it: the `@handoff(<key>)` control
 *  sentinel stripped (it drives the "Talk to X" banner, not message text) and
 *  trailing whitespace trimmed. Leading indentation is left alone — it is what
 *  nests list items and indents fenced code. */
export function prepareTranscriptText(content: string): string {
  return content.replace(/\B@handoff\([a-z0-9-]+\)/gi, '').trimEnd()
}

export function parseHeading(line: string): { level: number; text: string } | null {
  const m = line.match(HEADING_RE)
  return m ? { level: m[1]!.length, text: m[2] ?? '' } : null
}

function tableStartsAt(lines: string[], i: number): boolean {
  return lines[i]!.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!)
}

/** Strip ONE `>` level from a quoted line; nested quotes keep their inner `>`. */
export function unquoteLine(line: string): string {
  const m = line.match(QUOTE_RE)
  return m ? (m[1] ?? '') : line
}

export function isQuoteLine(line: string): boolean {
  return QUOTE_RE.test(line)
}

/** Split non-code-fence text into table / blockquote / heading / list /
 *  plain-text runs. A blockquote is a maximal run of `>`-prefixed lines; its
 *  `lines` come back with one `>` level removed so the caller can recurse for
 *  nesting. A list is a maximal run of list-item lines (a continuation line
 *  indented under an item is folded into that item's text). */
export function segmentBlocks(text: string): BlockSegment[] {
  const lines = text.split('\n')
  const out: BlockSegment[] = []
  let i = 0
  const startsBlock = (k: number) => tableStartsAt(lines, k) || isQuoteLine(lines[k]!) || parseHeading(lines[k]!) !== null || parseListItem(lines[k]!) !== null
  while (i < lines.length) {
    const heading = parseHeading(lines[i]!)
    const item = parseListItem(lines[i]!)
    if (heading) {
      out.push({ kind: 'heading', ...heading })
      i++
    } else if (item) {
      const items: ListItem[] = []
      // Marker columns of the open ancestors. CommonMark nests an item under the
      // nearest ancestor whose content it is indented past; `+ 2` (a `- ` marker)
      // is the lenient version so `  - b` still nests under `1. a`.
      const open: number[] = []
      const push = ({ indent, ...rest }: ParsedListItem) => {
        while (open.length && indent < open[open.length - 1]! + 2) open.pop()
        items.push({ depth: open.length, ...rest })
        open.push(indent)
      }
      push(item)
      i++
      while (i < lines.length) {
        const next = parseListItem(lines[i]!)
        if (next) { push(next); i++; continue }
        // Indented continuation of the previous item (not blank, not a new block).
        if (/^(?: {2,}|\t)\S/.test(lines[i]!) && !startsBlock(i)) { items[items.length - 1]!.text += ' ' + lines[i]!.trim(); i++; continue }
        break
      }
      out.push({ kind: 'list', items })
    } else if (tableStartsAt(lines, i)) {
      const header = lines[i]!
      i += 2
      const body: string[] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') body.push(lines[i++]!)
      out.push({ kind: 'table', header, body })
    } else if (isQuoteLine(lines[i]!)) {
      const quoted: string[] = []
      while (i < lines.length && isQuoteLine(lines[i]!)) quoted.push(unquoteLine(lines[i++]!))
      out.push({ kind: 'quote', lines: quoted })
    } else {
      const start = i
      while (i < lines.length && !startsBlock(i)) i++
      // Prose renders pre-wrap, so runs of spaces would show; collapse them here
      // only — list/code indentation must reach the parser intact.
      out.push({ kind: 'text', lines: lines.slice(start, i).map((l) => l.replace(/[ \t]{2,}/g, ' ')) })
    }
  }
  return out
}
