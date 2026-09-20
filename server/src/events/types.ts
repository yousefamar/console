// Hub events — a fact the hub observed, typed by topic, small, replayable.
// Events carry a SUMMARY and a POINTER (`ref`), never the full payload: the
// log stays small, wake envelopes stay small, and `where` filters are honest
// about what they can see. Anything bigger lives behind `ref`.

export interface HubEvent {
  /** Sortable, filesystem-safe: `2026-09-20T10-15-30.123Z-ab12`. */
  id: string
  /** Dotted, hierarchical: `mail.received`, `geo.enter`, `astera.release`. */
  topic: string
  /** Epoch ms the event was observed by the hub. */
  at: number
  /** Adapter instance that produced it: `matrix`, `gmail:yousefamar@gmail.com`, `cli:@console-general`. */
  source: string
  /** Idempotency key — the bus drops a repeat of the same (topic, key) within 24 h. */
  key?: string
  /** Incremented by `emit` actions deriving one event from another; capped. */
  hops: number
  data: Record<string, unknown>
  /** How to fetch the whole thing, as a command an agent can run. */
  ref?: string
}

export interface EmitInput {
  topic: string
  data: Record<string, unknown>
  source: string
  key?: string
  ref?: string
  hops?: number
  /** Override the observation time (replayed history, provider timestamps). */
  at?: number
}

export interface TopicDoc {
  topic: string
  description: string
  /** Field → meaning, for `con event topics`. */
  fields: Record<string, string>
  /** `false` = ring-buffered only, never written to the daily log. */
  logged?: boolean
}

export const TOPIC_RE = /^[a-z][a-z0-9]*(\.[a-z0-9_-]+)+$/
export const MAX_HOPS = 5
/** Serialized `data` above this is replaced by a truncated preview. */
export const MAX_DATA_BYTES = 16 * 1024
export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
export const RETENTION_DAYS = 90
export const RING_SIZE = 500

/** `chat.*` matches `chat.message` and `chat.x.y`; `*` matches everything; otherwise exact. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*' || pattern === topic) return true
  if (!pattern.includes('*')) return false
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return re.test(topic)
}
