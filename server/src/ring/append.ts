// Pure text edits the ring handlers make to vault notes.

/** `## YYYY-MM-DD` heading (once per day) + `- HH:MM text` bullet. */
export function appendLogEntry(existing: string | null, text: string, now: Date): string {
  const day = now.toISOString().slice(0, 10)
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const bullet = `- ${hh}:${mm} ${text.trim()}`
  const body = (existing ?? '').replace(/\s+$/, '')
  const lastHeading = [...body.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)].at(-1)?.[1]
  if (lastHeading === day) return `${body}\n${bullet}\n`
  return `${body ? `${body}\n\n` : ''}## ${day}\n${bullet}\n`
}

/** Append `- item` at the end of a list note. */
export function appendBullet(existing: string | null, item: string): string {
  const body = (existing ?? '').replace(/\s+$/, '')
  return `${body ? `${body}\n` : ''}- ${item.trim()}\n`
}

export interface MovieRow { title: string; year: string; series: string }

/** Append a row to the movie table (`| Title | Year | Series | Watched |`),
 *  dropping a trailing blank `|  |  |  |  |` row the editor leaves behind.
 *  No table in the file → falls back to a bullet. */
export function appendMovieRow(existing: string | null, row: MovieRow): string {
  const lines = (existing ?? '').replace(/\s+$/, '').split('\n')
  while (lines.length && /^\|(?:\s*\|)+$/.test(lines.at(-1)!.replace(/\s/g, ''))) lines.pop()
  const headerIdx = lines.findIndex((l) => /^\|\s*title\s*\|/i.test(l))
  if (headerIdx === -1) return appendBullet(lines.join('\n'), `${row.title} (${row.year})`)
  const cell = (s: string) => s.replace(/\|/g, '/').trim()
  // Match the header's column widths when the table is padded.
  const widths = lines[headerIdx]!.split('|').slice(1, -1).map((c) => c.length - 2)
  const cells = [cell(row.title), cell(row.year), cell(row.series), 'No']
  const padded = cells.map((c, i) => ` ${c.padEnd(Math.max(widths[i] ?? 0, c.length))} `)
  return `${lines.join('\n')}\n|${padded.join('|')}|\n`
}
