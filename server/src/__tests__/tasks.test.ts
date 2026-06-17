import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../agents/tasks.js'

let dir: string
let file: string
let clock: number
const now = () => clock
function fresh() { return new TaskStore(file, now) }
function mk(store: TaskStore, over: Partial<Parameters<TaskStore['create']>[0]> = {}) {
  return store.create({ title: 'T', brief: 'do it', fromKey: 'al', toKey: 'eng', origin: 'human', parentTaskId: null, chain: ['al', 'eng'], ...over })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tasks-'))
  file = join(dir, 'agent-tasks.json')
  clock = 1_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('TaskStore', () => {
  it('creates a task in_progress with a unique id and persists', () => {
    const s = fresh()
    const t = mk(s)
    expect(t.status).toBe('in_progress')
    expect(t.id).toMatch(/^tsk_/)
    expect(existsSync(file)).toBe(true)
    expect(mk(s).id).not.toBe(t.id) // unique
  })

  it('reloads persisted tasks from disk', () => {
    const a = mk(fresh())
    const s2 = fresh()
    expect(s2.get(a.id)?.brief).toBe('do it')
  })

  it('updates status/result and bumps updatedAt', () => {
    const s = fresh()
    const t = mk(s)
    clock += 5000
    const u = s.update(t.id, { status: 'done', result: 'shipped' })
    expect(u?.status).toBe('done')
    expect(u?.result).toBe('shipped')
    expect(u?.updatedAt).toBe(1_005_000)
  })

  it('queries: open / openForAssignee / byDelegator / children', () => {
    const s = fresh()
    const parent = mk(s, { toKey: 'eng' })
    const child = mk(s, { fromKey: 'eng', toKey: 'fe', parentTaskId: parent.id, chain: ['al', 'eng', 'fe'] })
    s.update(parent.id, { status: 'done' })
    expect(s.open().map((t) => t.id)).toEqual([child.id])
    expect(s.openForAssignee('fe').map((t) => t.id)).toEqual([child.id])
    expect(s.byDelegator('al').map((t) => t.id)).toEqual([parent.id])
    expect(s.children(parent.id).map((t) => t.id)).toEqual([child.id])
  })

  it('prunes terminal tasks older than the TTL but keeps open ones', () => {
    const s = fresh()
    const oldDone = mk(s); s.update(oldDone.id, { status: 'done' })
    const openOld = mk(s)
    clock += 8 * 24 * 60 * 60 * 1000 // > 7d TTL
    const removed = s.prune()
    expect(removed).toBe(1)
    expect(s.get(oldDone.id)).toBeUndefined()
    expect(s.get(openOld.id)).toBeDefined() // open never pruned
  })

  it('cancel marks a task cancelled', () => {
    const s = fresh()
    const t = mk(s)
    s.cancel(t.id)
    expect(s.get(t.id)?.status).toBe('cancelled')
    expect(s.open()).toHaveLength(0)
  })
})
