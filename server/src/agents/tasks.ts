// ============================================================================
// Delegation task store — the spine of org-aware delegation.
//
// A Task is a small durable record of "agent X asked agent Y to do Z". It lets
// a result route back to the delegator (report-up through managers) and lets the
// UI/CLI show what's in flight. Deliberately minimal — NOT a Postgres ticket
// tracker (see the delegation plan): file-backed JSON, atomic writes, pruned.
//
// Mirrors server/src/model-config.ts (atomic tmp+rename persist) and the
// registry/cron file-store pattern. Pure-ish → unit-tested.
// ============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'cancelled'

export interface AgentTask {
  /** tsk_<base36> — stable id used by `con agent report <id>`. */
  id: string
  title: string
  /** The instruction handed to the assignee. */
  brief: string
  /** Delegator agentKey ('al' at the top of a human-originated chain). */
  fromKey: string
  /** Assignee agentKey. */
  toKey: string
  /** Top of the chain: a human (Yousef→Al) or another agent. */
  origin: 'human' | 'agent'
  /** Parent task id when this is a sub-delegation (report bubbles to it). */
  parentTaskId: string | null
  /** [topKey, …, toKey] — used for the depth cap, cycle guard, and display. */
  chain: string[]
  status: TaskStatus
  result: string | null
  /** The hub session embodying the assignee for THIS task (durable or ephemeral). */
  workerSessionId?: string
  /** True when a fresh role-less worker was spawned for this task (vs the
   *  assignee's durable session) — killed on report. */
  ephemeral?: boolean
  /** How many watchdog nudges have been sent for a stalled in-progress task. */
  nudges?: number
  createdAt: number
  updatedAt: number
}

const OPEN_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'blocked']
const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled']
/** Drop terminal tasks older than this on load + periodically. */
const PRUNE_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface PersistedState { tasks: AgentTask[]; seq: number }

export interface CreateTaskInput {
  title: string
  brief: string
  fromKey: string
  toKey: string
  origin: 'human' | 'agent'
  parentTaskId: string | null
  chain: string[]
  ephemeral?: boolean
  workerSessionId?: string
}

export class TaskStore {
  private state: PersistedState = { tasks: [], seq: 0 }

  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
    private log: (m: string) => void = () => {},
  ) {
    this.load()
  }

  get(id: string): AgentTask | undefined {
    return this.state.tasks.find((t) => t.id === id)
  }

  list(): AgentTask[] {
    return [...this.state.tasks]
  }

  /** Non-terminal tasks (pending / in_progress / blocked). */
  open(): AgentTask[] {
    return this.state.tasks.filter((t) => OPEN_STATUSES.includes(t.status))
  }

  /** Open tasks assigned to `toKey` (what an agent owes). */
  openForAssignee(toKey: string): AgentTask[] {
    return this.open().filter((t) => t.toKey === toKey)
  }

  /** Tasks delegated by `fromKey` (what an agent is owed). */
  byDelegator(fromKey: string): AgentTask[] {
    return this.state.tasks.filter((t) => t.fromKey === fromKey)
  }

  /** Direct sub-tasks of `parentTaskId` (for manager aggregation). */
  children(parentTaskId: string): AgentTask[] {
    return this.state.tasks.filter((t) => t.parentTaskId === parentTaskId)
  }

  create(input: CreateTaskInput): AgentTask {
    const ts = this.now()
    const task: AgentTask = {
      id: this.nextId(),
      title: input.title.slice(0, 200) || 'Task',
      brief: input.brief,
      fromKey: input.fromKey,
      toKey: input.toKey,
      origin: input.origin,
      parentTaskId: input.parentTaskId,
      chain: input.chain,
      status: 'in_progress',
      result: null,
      ephemeral: input.ephemeral,
      workerSessionId: input.workerSessionId,
      nudges: 0,
      createdAt: ts,
      updatedAt: ts,
    }
    this.state.tasks.push(task)
    this.persist()
    return task
  }

  update(id: string, patch: Partial<Omit<AgentTask, 'id' | 'createdAt'>>): AgentTask | undefined {
    const task = this.get(id)
    if (!task) return undefined
    Object.assign(task, patch, { updatedAt: this.now() })
    this.persist()
    return task
  }

  /** Mark a task terminal (default cancelled). */
  cancel(id: string): AgentTask | undefined {
    return this.update(id, { status: 'cancelled' })
  }

  /** Drop terminal tasks older than the TTL. Returns how many were removed. */
  prune(): number {
    const cutoff = this.now() - PRUNE_TTL_MS
    const before = this.state.tasks.length
    this.state.tasks = this.state.tasks.filter(
      (t) => !(TERMINAL_STATUSES.includes(t.status) && t.updatedAt < cutoff),
    )
    const removed = before - this.state.tasks.length
    if (removed > 0) this.persist()
    return removed
  }

  private nextId(): string {
    this.state.seq += 1
    return `tsk_${this.now().toString(36)}${this.state.seq.toString(36)}`
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<PersistedState>
      if (Array.isArray(raw.tasks)) this.state.tasks = raw.tasks as AgentTask[]
      if (typeof raw.seq === 'number') this.state.seq = raw.seq
      this.prune()
    } catch (e) {
      this.log(`[tasks] load failed: ${(e as Error).message}`)
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      this.log(`[tasks] save failed: ${(e as Error).message}`)
    }
  }
}
