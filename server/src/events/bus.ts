// EventBus — the hub's one in-process pub/sub. Adapters emit; the listener
// engine, WS tails and the log subscribe. Order on emit: validate → dedup →
// persist (log or ring) → in-process subscribers → tails. Persist comes
// before dispatch so a crash mid-dispatch leaves the event on disk for the
// journal-driven re-run (see listeners/engine.ts).

import type { WebSocket } from 'ws'
import { EventStore } from './store.js'
import { BUILTIN_TOPICS } from './topics.js'
import {
  DEDUP_WINDOW_MS, MAX_DATA_BYTES, MAX_HOPS, RING_SIZE, TOPIC_RE, topicMatches,
  type EmitInput, type HubEvent, type TopicDoc,
} from './types.js'

export type Subscriber = (ev: HubEvent) => void
export type EmitFn = (input: EmitInput) => HubEvent | null

export interface EmitOutcome {
  event: HubEvent | null
  /** Why `event` is null. */
  dropped?: 'invalid-topic' | 'duplicate' | 'hops'
}

const HEARTBEAT_MS = 30_000

export class EventBus {
  private readonly subs: Array<{ pattern: string; fn: Subscriber }> = []
  private readonly tails = new Set<{ ws: WebSocket; pattern: string }>()
  private readonly dedup: Map<string, number>
  private readonly ring: HubEvent[] = []
  private readonly topicDocs = new Map<string, TopicDoc>()
  private readonly lastSeen = new Map<string, HubEvent>()
  private readonly counts = new Map<string, number>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0

  constructor(
    readonly store: EventStore,
    private readonly log: (msg: string) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const t of BUILTIN_TOPICS) this.topicDocs.set(t.topic, t)
    this.dedup = store.recentKeys(DEDUP_WINDOW_MS, this.now())
    for (const ev of store.list({ limit: 1000, since: this.now() - 7 * 86_400_000 }).reverse()) this.remember(ev)
  }

  /** Begin the liveness heartbeat and prune the log. Call once at boot. */
  start(): void {
    this.startedAt = this.now()
    const gone = this.store.prune()
    if (gone.length) this.log(`[events] pruned ${gone.length} day file(s) past retention`)
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.store.heartbeat(this.now()), HEARTBEAT_MS)
      this.heartbeatTimer.unref?.()
    }
  }

  stop(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    this.store.heartbeat(this.now())
  }

  /** `hub.started` — once, after every adapter and the listener engine are wired. */
  emitStarted(): HubEvent | null {
    const last = this.store.lastAlive()
    const now = this.now()
    const ev = this.emit({
      topic: 'hub.started',
      source: 'hub',
      data: { downSince: last, downMs: last ? Math.max(0, now - last) : null, pid: process.pid },
    })
    this.store.heartbeat(now)
    return ev
  }

  subscribe(pattern: string, fn: Subscriber): () => void {
    const entry = { pattern, fn }
    this.subs.push(entry)
    return () => { const i = this.subs.indexOf(entry); if (i >= 0) this.subs.splice(i, 1) }
  }

  attachTail(ws: WebSocket, pattern = '*'): void {
    const entry = { ws, pattern }
    this.tails.add(entry)
    ws.on('close', () => this.tails.delete(entry))
    ws.on('error', () => this.tails.delete(entry))
  }

  emit(input: EmitInput): HubEvent | null {
    return this.emitWithOutcome(input).event
  }

  emitWithOutcome(input: EmitInput): EmitOutcome {
    const topic = input.topic.trim()
    if (!TOPIC_RE.test(topic)) return { event: null, dropped: 'invalid-topic' }
    const hops = input.hops ?? 0
    if (hops > MAX_HOPS) { this.log(`[events] dropped ${topic}: hop limit (${hops})`); return { event: null, dropped: 'hops' } }
    const at = input.at ?? this.now()
    if (input.key) {
      const k = `${topic}\u0000${input.key}`
      const seen = this.dedup.get(k)
      if (seen !== undefined && at - seen < DEDUP_WINDOW_MS) return { event: null, dropped: 'duplicate' }
      this.dedup.set(k, at)
      if (this.dedup.size > 20_000) this.pruneDedup(at)
    }
    const ev: HubEvent = {
      id: this.store.mintId(at),
      topic,
      at,
      source: input.source,
      ...(input.key ? { key: input.key } : {}),
      hops,
      data: clampData(input.data),
      ...(input.ref ? { ref: input.ref } : {}),
    }
    const doc = this.topicDocs.get(topic)
    if (!doc) this.topicDocs.set(topic, { topic, description: `custom topic (first seen from ${input.source})`, fields: Object.fromEntries(Object.keys(ev.data).map((k) => [k, ''])) })
    if (doc?.logged === false) {
      this.ring.push(ev)
      if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
    } else {
      this.store.append(ev)
    }
    this.remember(ev)
    for (const s of this.subs) {
      if (!topicMatches(s.pattern, topic)) continue
      try { s.fn(ev) } catch (e) { this.log(`[events] subscriber threw on ${topic}: ${(e as Error).message}`) }
    }
    if (this.tails.size) {
      const frame = JSON.stringify(ev)
      for (const t of this.tails) {
        if (!topicMatches(t.pattern, topic)) continue
        try { if (t.ws.readyState === 1) t.ws.send(frame) } catch { this.tails.delete(t) }
      }
    }
    return { event: ev }
  }

  /** Archived events plus the ring for unlogged topics. */
  list(q: Parameters<EventStore['list']>[0] = {}): HubEvent[] {
    const ringHits = q.topic
      ? this.ring.filter((e) => topicMatches(q.topic!, e.topic) && (q.since === undefined || e.at >= q.since)).reverse()
      : []
    const stored = this.store.list(q)
    if (!ringHits.length) return stored
    return [...ringHits, ...stored].sort((a, b) => b.at - a.at).slice(0, q.limit ?? 50)
  }

  get(id: string): HubEvent | null {
    return this.ring.find((e) => e.id === id) ?? this.store.get(id)
  }

  topics(): Array<TopicDoc & { lastSeen: HubEvent | null; count: number }> {
    return [...this.topicDocs.values()]
      .map((d) => ({ ...d, lastSeen: this.lastSeen.get(d.topic) ?? null, count: this.counts.get(d.topic) ?? 0 }))
      .sort((a, b) => a.topic.localeCompare(b.topic))
  }

  status(): { startedAt: number; topics: number; subscribers: number; tails: number; dedupKeys: number } {
    return { startedAt: this.startedAt, topics: this.topicDocs.size, subscribers: this.subs.length, tails: this.tails.size, dedupKeys: this.dedup.size }
  }

  private remember(ev: HubEvent): void {
    this.lastSeen.set(ev.topic, ev)
    this.counts.set(ev.topic, (this.counts.get(ev.topic) ?? 0) + 1)
  }

  private pruneDedup(now: number): void {
    for (const [k, at] of this.dedup) if (now - at >= DEDUP_WINDOW_MS) this.dedup.delete(k)
  }
}

/** Oversized data becomes a preview rather than a rejected event — the source
 *  is usually an adapter that forgot to summarise, and losing the event is worse. */
export function clampData(data: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.stringify(data ?? {})
  if (s.length <= MAX_DATA_BYTES) return data ?? {}
  return { _truncated: true, _bytes: s.length, preview: s.slice(0, 2000) }
}
