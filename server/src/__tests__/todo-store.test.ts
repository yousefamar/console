import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTodos, todosEqual, watchTodos, type TodoItem } from '../agents/todo-store.js'

const CSID = 'sess-abc'
let root: string

function write(id: string, body: unknown) {
  writeFileSync(join(root, CSID, `${id}.json`), JSON.stringify(body))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'console-todos-'))
  process.env.CONSOLE_CLAUDE_TASKS_DIR = root
  mkdirSync(join(root, CSID), { recursive: true })
})

afterEach(() => {
  delete process.env.CONSOLE_CLAUDE_TASKS_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('readTodos', () => {
  it('parses the CLI on-disk shape', () => {
    write('1', {
      id: '1', subject: 'alpha', description: 'do alpha',
      activeForm: 'Doing alpha', status: 'in_progress', blocks: [], blockedBy: [],
    })
    expect(readTodos(CSID)).toEqual([
      { id: '1', subject: 'alpha', description: 'do alpha', activeForm: 'Doing alpha', status: 'in_progress' },
    ])
  })

  it('omits absent optional fields rather than emitting undefined', () => {
    write('1', { id: '1', subject: 'bare', status: 'pending' })
    const [t] = readTodos(CSID)
    expect(t).toEqual({ id: '1', subject: 'bare', status: 'pending' })
    expect('activeForm' in t!).toBe(false)
    expect('description' in t!).toBe(false)
  })

  it('sorts numerically, not lexically', () => {
    for (const id of ['10', '2', '1', '13']) write(id, { id, subject: `t${id}`, status: 'pending' })
    expect(readTodos(CSID).map((t) => t.id)).toEqual(['1', '2', '10', '13'])
  })

  it('falls back to a lexical sort for non-numeric ids', () => {
    for (const id of ['b', 'a', 'c']) write(id, { id, subject: id, status: 'pending' })
    expect(readTodos(CSID).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('skips the .lock file and any other non-json entry', () => {
    writeFileSync(join(root, CSID, '.lock'), '')
    writeFileSync(join(root, CSID, 'notes.txt'), 'hello')
    write('1', { id: '1', subject: 'only', status: 'completed' })
    expect(readTodos(CSID).map((t) => t.subject)).toEqual(['only'])
  })

  it('tolerates a malformed / half-written file', () => {
    writeFileSync(join(root, CSID, '2.json'), '{"id":"2","subj')
    write('1', { id: '1', subject: 'good', status: 'pending' })
    expect(readTodos(CSID).map((t) => t.id)).toEqual(['1'])
  })

  it('drops entries with no subject or an unknown status', () => {
    write('1', { id: '1', status: 'pending' })
    write('2', { id: '2', subject: 'weird', status: 'cancelled' })
    write('3', { id: '3', subject: 'ok', status: 'completed' })
    expect(readTodos(CSID).map((t) => t.id)).toEqual(['3'])
  })

  it('derives the id from the filename when the body omits it', () => {
    write('7', { subject: 'nameless', status: 'pending' })
    expect(readTodos(CSID)[0]!.id).toBe('7')
  })

  it('returns [] for a session with no dir, and never throws', () => {
    expect(readTodos('never-existed')).toEqual([])
    rmSync(root, { recursive: true, force: true })
    expect(readTodos(CSID)).toEqual([])
  })
})

describe('todosEqual', () => {
  const a: TodoItem[] = [{ id: '1', subject: 'x', status: 'pending' }]
  it('is true for identical lists', () => {
    expect(todosEqual(a, [{ id: '1', subject: 'x', status: 'pending' }])).toBe(true)
  })
  it('detects a status change, a rename, and a length change', () => {
    expect(todosEqual(a, [{ id: '1', subject: 'x', status: 'completed' }])).toBe(false)
    expect(todosEqual(a, [{ id: '1', subject: 'y', status: 'pending' }])).toBe(false)
    expect(todosEqual(a, [])).toBe(false)
  })
  it('detects an activeForm change (the label the UI shows while running)', () => {
    expect(todosEqual(
      [{ id: '1', subject: 'x', status: 'in_progress', activeForm: 'Xing' }],
      [{ id: '1', subject: 'x', status: 'in_progress', activeForm: 'Doing x' }],
    )).toBe(false)
  })
})

describe('watchTodos', () => {
  it('debounces a burst of writes into ONE callback with the final list', async () => {
    const seen: TodoItem[][] = []
    const stop = watchTodos(CSID, (t) => seen.push(t))
    try {
      write('1', { id: '1', subject: 'a', status: 'pending' })
      write('2', { id: '2', subject: 'b', status: 'pending' })
      write('3', { id: '3', subject: 'c', status: 'pending' })
      await new Promise((r) => setTimeout(r, 400))
      expect(seen.length).toBe(1)
      expect(seen[0]!.map((t) => t.id)).toEqual(['1', '2', '3'])
    } finally { stop() }
  })

  it('does not fire when a write leaves the list unchanged', async () => {
    write('1', { id: '1', subject: 'a', status: 'pending' })
    const seen: TodoItem[][] = []
    const stop = watchTodos(CSID, (t) => seen.push(t))
    try {
      write('1', { id: '1', subject: 'a', status: 'pending', blocks: [] })
      await new Promise((r) => setTimeout(r, 400))
      expect(seen).toEqual([])
    } finally { stop() }
  })

  it('picks up a status flip', async () => {
    write('1', { id: '1', subject: 'a', status: 'pending' })
    const seen: TodoItem[][] = []
    const stop = watchTodos(CSID, (t) => seen.push(t))
    try {
      write('1', { id: '1', subject: 'a', status: 'in_progress', activeForm: 'Aing' })
      await new Promise((r) => setTimeout(r, 400))
      expect(seen.at(-1)).toEqual([{ id: '1', subject: 'a', status: 'in_progress', activeForm: 'Aing' }])
    } finally { stop() }
  })

  it('attaches to a dir that does not exist yet (created on first TaskCreate)', async () => {
    const late = 'sess-late'
    const seen: TodoItem[][] = []
    const stop = watchTodos(late, (t) => seen.push(t))
    try {
      mkdirSync(join(root, late), { recursive: true })
      writeFileSync(join(root, late, '1.json'), JSON.stringify({ id: '1', subject: 'late', status: 'pending' }))
      await new Promise((r) => setTimeout(r, 500))
      expect(seen.at(-1)?.map((t) => t.subject)).toEqual(['late'])
    } finally { stop() }
  })

  it('stops firing after the disposer runs', async () => {
    const seen: TodoItem[][] = []
    const stop = watchTodos(CSID, (t) => seen.push(t))
    write('1', { id: '1', subject: 'a', status: 'pending' })
    stop()
    write('2', { id: '2', subject: 'b', status: 'pending' })
    await new Promise((r) => setTimeout(r, 400))
    expect(seen).toEqual([])
  })
})
