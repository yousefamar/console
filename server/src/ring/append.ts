// Pure text edits the ring handlers make to LOG notes (lists are tables — table.ts).

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
