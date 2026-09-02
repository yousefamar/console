// Recent outbound WhatsApp sends, per CONTACT (not per JID).
//
// A contact can reach us from several JIDs (phone `447…@s.whatsapp.net`,
// linked-device `…@lid`), while our sends go to whichever one we picked.
// A short reply ("Thank youuu") arriving a minute after a send on the OTHER
// JID has no visible antecedent in the thread the model was told it owns —
// observed live 2026-09-02: the Al↔nica fork answered a 34-hour-old yoga
// message instead of the dinosaur fact sent 60 s earlier. Surfacing "what I
// just said to this person" in the inbound envelope closes that gap.
//
// In-memory only: the transcript is the durable record; this is a hint.

export interface OutboundEntry {
  text: string
  ts: number
  jid: string
}

const MAX_PER_CONTACT = 5
const DEFAULT_WITHIN_MS = 48 * 60 * 60_000
const DEFAULT_LIMIT = 3
const PREVIEW_CHARS = 160

const ledger = new Map<string, OutboundEntry[]>()

export function recordOutbound(contactKey: string, entry: OutboundEntry): void {
  const list = ledger.get(contactKey) ?? []
  list.push(entry)
  while (list.length > MAX_PER_CONTACT) list.shift()
  ledger.set(contactKey, list)
}

/** Newest first, within the window. */
export function recentOutbound(
  contactKey: string,
  opts: { now?: number; withinMs?: number; limit?: number } = {},
): OutboundEntry[] {
  const now = opts.now ?? Date.now()
  const withinMs = opts.withinMs ?? DEFAULT_WITHIN_MS
  const limit = opts.limit ?? DEFAULT_LIMIT
  return (ledger.get(contactKey) ?? [])
    .filter((e) => now - e.ts <= withinMs)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

export function resetOutboundLedger(): void {
  ledger.clear()
}

export function relativeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** Envelope lines for the "your recent messages to this contact" block. */
export function formatRecentOutbound(entries: OutboundEntry[], now = Date.now()): string[] {
  return entries.map((e) => {
    const oneLine = e.text.replace(/\s+/g, ' ').trim()
    const preview = oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS - 1)}…` : oneLine
    return `  • ${relativeAgo(now - e.ts)}: "${preview}"`
  })
}
