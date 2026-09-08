// Line-level block segmentation for the transcript's markdown-lite renderer.
// Pure (no React) so it can be unit-tested in the node vitest environment.

export type BlockSegment =
  | { kind: 'text'; lines: string[] }
  | { kind: 'table'; header: string; body: string[] }
  | { kind: 'quote'; lines: string[] }

const TABLE_SEP_RE = /^\s*\|?\s*[-:]+[-| :]*$/
const QUOTE_RE = /^ {0,3}>(?: ?(.*))?$/

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

/** Split non-code-fence text into table / blockquote / plain-text runs.
 *  A blockquote is a maximal run of `>`-prefixed lines; its `lines` come back
 *  with one `>` level removed so the caller can recurse for nesting. */
export function segmentBlocks(text: string): BlockSegment[] {
  const lines = text.split('\n')
  const out: BlockSegment[] = []
  let i = 0
  while (i < lines.length) {
    if (tableStartsAt(lines, i)) {
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
      while (i < lines.length && !tableStartsAt(lines, i) && !isQuoteLine(lines[i]!)) i++
      out.push({ kind: 'text', lines: lines.slice(start, i) })
    }
  }
  return out
}
