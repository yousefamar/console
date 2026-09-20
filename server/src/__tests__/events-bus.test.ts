import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../events/store.js'
import { EventBus } from '../events/bus.js'
import { topicMatches } from '../events/types.js'
import { parseSince } from '../routes/events.js'

let dir: string
let clock: number
const now = () => clock

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'events-')); clock = Date.parse('2026-09-20T10:00:00Z') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const mk = () => new EventBus(new EventStore(dir), () => {}, now)

describe('topicMatches', () => {
  it('exact, glob, star', () => {
    expect(topicMatches('chat.message', 'chat.message')).toBe(true)
    expect(topicMatches('chat.*', 'chat.message')).toBe(true)
    expect(topicMatches('chat.*', 'chat.x.y')).toBe(true)
    expect(topicMatches('chat.*', 'mail.received')).toBe(false)
    expect(topicMatches('*', 'anything.at.all')).toBe(true)
    expect(topicMatches('geo.enter', 'geo.leave')).toBe(false)
  })
})

describe('EventBus: emit → log → subscribers', () => {
  it('persists a line before dispatching and hands subscribers the same event', () => {
    const bus = mk()
    const seen: string[] = []
    bus.subscribe('mail.*', (e) => seen.push(e.id))
    bus.subscribe('geo.*', (e) => seen.push(`geo:${e.id}`))
    const ev = bus.emit({ topic: 'mail.received', source: 'gmail:a', data: { subject: 'hi' }, key: 'm1', ref: 'con mail read t1' })!
    expect(ev.id.startsWith('2026-09-20T10-00-00')).toBe(true)
    expect(seen).toEqual([ev.id])
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files).toEqual(['2026-09-20.jsonl'])
    const line = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8').trim())
    expect(line.topic).toBe('mail.received')
    expect(line.ref).toBe('con mail read t1')
    expect(bus.get(ev.id)?.data).toEqual({ subject: 'hi' })
  })

  it('rejects malformed topics and caps hops', () => {
    const bus = mk()
    expect(bus.emitWithOutcome({ topic: 'Bad Topic', source: 'x', data: {} })).toEqual({ event: null, dropped: 'invalid-topic' })
    expect(bus.emitWithOutcome({ topic: 'nodot', source: 'x', data: {} }).dropped).toBe('invalid-topic')
    expect(bus.emitWithOutcome({ topic: 'a.b', source: 'x', data: {}, hops: 6 }).dropped).toBe('hops')
    expect(bus.emitWithOutcome({ topic: 'a.b', source: 'x', data: {}, hops: 5 }).event).not.toBeNull()
  })

  it('dedups (topic,key) within 24 h and rebuilds the set from disk on restart', () => {
    const bus = mk()
    expect(bus.emit({ topic: 'chat.message', source: 'matrix', data: {}, key: '$e1' })).not.toBeNull()
    expect(bus.emitWithOutcome({ topic: 'chat.message', source: 'matrix', data: {}, key: '$e1' }).dropped).toBe('duplicate')
    expect(bus.emit({ topic: 'mail.received', source: 'g', data: {}, key: '$e1' })).not.toBeNull()
    // "restart": a fresh bus over the same dir must still know $e1
    const bus2 = mk()
    expect(bus2.emitWithOutcome({ topic: 'chat.message', source: 'matrix', data: {}, key: '$e1' }).dropped).toBe('duplicate')
    clock += 25 * 3_600_000
    expect(bus2.emit({ topic: 'chat.message', source: 'matrix', data: {}, key: '$e1' })).not.toBeNull()
  })

  it('a throwing subscriber does not stop the others', () => {
    const bus = mk()
    const seen: string[] = []
    bus.subscribe('*', () => { throw new Error('boom') })
    bus.subscribe('*', (e) => seen.push(e.topic))
    bus.emit({ topic: 'x.y', source: 't', data: {} })
    expect(seen).toEqual(['x.y'])
  })

  it('oversized data is clamped to a preview instead of rejected', () => {
    const bus = mk()
    const ev = bus.emit({ topic: 'x.big', source: 't', data: { blob: 'a'.repeat(40_000) } })!
    expect(ev.data._truncated).toBe(true)
    expect(String(ev.data.preview).length).toBe(2000)
  })

  it('unlogged topics stay in the ring and are still listable', () => {
    const bus = mk()
    for (let i = 0; i < 3; i++) { clock += 1000; bus.emit({ topic: 'location.fix', source: 'ot', data: { i } }) }
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toEqual([])
    const fixes = bus.list({ topic: 'location.fix' })
    expect(fixes.map((e) => e.data.i)).toEqual([2, 1, 0])
    expect(bus.get(fixes[0]!.id)).not.toBeNull()
  })

  it('custom topics register themselves and topics() reports last example + count', () => {
    const bus = mk()
    bus.emit({ topic: 'astera.release', source: 'cli:@astera', data: { sha: 'abc' } })
    bus.emit({ topic: 'astera.release', source: 'cli:@astera', data: { sha: 'def' } })
    const t = bus.topics().find((x) => x.topic === 'astera.release')!
    expect(t.count).toBe(2)
    expect(t.lastSeen?.data.sha).toBe('def')
    expect(bus.topics().some((x) => x.topic === 'hub.started')).toBe(true)
  })

  it('hub.started carries the downtime since the last heartbeat', () => {
    const store = new EventStore(dir)
    store.heartbeat(clock - 90_000)
    const bus = new EventBus(store, () => {}, now)
    const ev = bus.emitStarted()!
    expect(ev.data.downMs).toBe(90_000)
    expect(ev.data.downSince).toBe(clock - 90_000)
    // a fresh install: no heartbeat file → null downtime
    const dir2 = mkdtempSync(join(tmpdir(), 'events2-'))
    const ev2 = new EventBus(new EventStore(dir2), () => {}, now).emitStarted()!
    expect(ev2.data.downSince).toBeNull()
    rmSync(dir2, { recursive: true, force: true })
  })
})

describe('EventStore: query + retention', () => {
  it('lists newest first across day files with since/topic/limit and tolerates a torn line', () => {
    const store = new EventStore(dir)
    const bus = new EventBus(store, () => {}, now)
    bus.emit({ topic: 'a.one', source: 't', data: { n: 1 } })
    clock += 86_400_000
    bus.emit({ topic: 'a.two', source: 't', data: { n: 2 } })
    bus.emit({ topic: 'b.three', source: 't', data: { n: 3 } })
    writeFileSync(join(dir, '2026-09-21.jsonl'), `${readFileSync(join(dir, '2026-09-21.jsonl'), 'utf8')}{"torn`)
    expect(store.list().map((e) => e.data.n)).toEqual([3, 2, 1])
    expect(store.list({ topic: 'a.*' }).map((e) => e.data.n)).toEqual([2, 1])
    expect(store.list({ since: clock - 3_600_000 }).map((e) => e.data.n)).toEqual([3, 2])
    expect(store.list({ limit: 1 }).map((e) => e.data.n)).toEqual([3])
    expect(store.get(store.list({ topic: 'a.one' })[0]!.id)?.data.n).toBe(1)
    expect(store.get('nonsense')).toBeNull()
  })

  it('prunes day files past retention', () => {
    const store = new EventStore(dir)
    writeFileSync(join(dir, '2026-01-01.jsonl'), '')
    writeFileSync(join(dir, '2026-09-19.jsonl'), '')
    expect(store.prune(90, clock)).toEqual(['2026-01-01.jsonl'])
  })
})

describe('parseSince', () => {
  it('relative, epoch, iso', () => {
    const t = Date.parse('2026-09-20T10:00:00Z')
    expect(parseSince('2h', t)).toBe(t - 7_200_000)
    expect(parseSince('30m', t)).toBe(t - 1_800_000)
    expect(parseSince(String(t), t)).toBe(t)
    expect(parseSince('2026-09-20T09:00:00Z', t)).toBe(t - 3_600_000)
    expect(parseSince('garbage', t)).toBeUndefined()
    expect(parseSince(null, t)).toBeUndefined()
  })
})
