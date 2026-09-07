// Pure text edits the ring handlers make to LOG notes (lists are tables — table.ts).

/** `## YYYY-MM-DD` heading (once per day) + `- HH:MM text` bullet. */
export function appendLogEntry(existing: string | null, text: string, now: Date): string {
  // Local date, not toISOString(): HH:MM below is local, so a UTC day would
  // file a 00:16 BST entry under the previous day (^soft-tern).
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  const hh = p(now.getHours())
  const mm = p(now.getMinutes())
  const bullet = `- ${hh}:${mm} ${text.trim()}`
  const body = (existing ?? '').replace(/\s+$/, '')
  const lastHeading = [...body.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)].at(-1)?.[1]
  if (lastHeading === day) return `${body}\n${bullet}\n`
  return `${body ? `${body}\n\n` : ''}## ${day}\n${bullet}\n`
}
