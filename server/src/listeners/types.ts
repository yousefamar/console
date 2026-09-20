// Listeners — agent-owned rules over the event bus. `on` a topic, `where`
// a filter holds, [`guard` a script agrees], do ONE action. Each rule walks
// the cost ladder: in-process filter → window/coalesce/cooldown → shell guard
// → action; `wake` (an LLM turn) is the last rung and the only one that
// costs tokens.

export type WhereOp = '=' | '!=' | '~' | '>' | '<' | '>=' | '<=' | '^=' | 'in'

export interface WhereClause {
  /** Dotted path into the event: `data.room`, `topic`, `data.headers.x-github-event`. */
  path: string
  op: WhereOp
  value: string
}

export type ListenerAction =
  | { type: 'wake'; prompt: string; /** wake this agentKey's live session instead of the owner */ as?: string }
  | { type: 'run'; cmd: string }
  | { type: 'post'; url: string; method?: string; headers?: Record<string, string> }
  | { type: 'notify'; title: string; body?: string }
  | { type: 'emit'; topic: string; data?: Record<string, unknown> }
  | { type: 'card'; project: string; text: string; column?: string; assign?: string }

export type OutcomeStage =
  | 'matched'        // passed where; batched (pending)
  | 'firing'         // batch taken off pending, guard/action in progress — a restart here re-runs it
  | 'fired'
  | 'guard-skipped'  // guard exited non-zero: deliberate no-op
  | 'dropped'        // outside the active window with dropOutside
  | 'paused'         // ceiling hit; events stay pending
  | 'skipped'        // wake target not live / action failed — counts toward auto-disable
  | 'error'

export interface Outcome {
  at: number
  stage: OutcomeStage
  events: string[]
  detail?: string
}

export interface ListenerOwner {
  claudeSessionId: string
  agentKey?: string
  /** Where `run` and `guard` execute. */
  cwd?: string
}

export interface Listener {
  id: string
  name?: string
  owner: ListenerOwner
  createdAt: number
  on: string
  where: WhereClause[]
  guard?: string
  /** Quiet period before acting; matching events in it are batched into one action. */
  coalesceMs: number
  /** Minimum gap between actions; events inside it are batched, not dropped. */
  cooldownMs: number
  /** `07:00-23:00` in Europe/London. */
  hours?: string
  /** `Mon-Fri` or `Mon,Wed,Sat`. */
  days?: string
  /** Outside the window: drop instead of holding until it opens. */
  dropOutside?: boolean
  maxPerHour: number
  action: ListenerAction
  pausedAt?: number
  pauseReason?: string
  disabledAt?: number
  consecutiveSkips: number
  stats: {
    matched: number
    fired: number
    guardSkipped: number
    lastEventAt?: number
    lastFiredAt?: number
    lastOutcome?: string
  }
  /** Coalesce batch waiting to fire. Persisted so a restart flushes it. */
  pending?: { events: string[]; startedAt: number; dueAt: number }
  /** Fire timestamps in the last hour (ceiling). */
  firedAt: number[]
  /** Last MAX_OUTCOMES stages, newest last. `firing` with no successor = interrupted. */
  outcomes: Outcome[]
}

export const MAX_OUTCOMES = 50
export const GUARD_TIMEOUT_MS = 60_000
export const GUARD_OUTPUT_CAP = 4000
export const RUN_TIMEOUT_MS = 60_000
export const MAX_BATCH = 50
export const DEFAULT_COALESCE_WAKE_MS = 60_000
export const DEFAULT_MAX_PER_HOUR_WAKE = 12
export const DEFAULT_MAX_PER_HOUR = 60
export const MAX_SKIPS_BEFORE_DISABLE = 10
export const SKIPS_BEFORE_WARN = 3
export const OVERDUE_PENDING_MAX_MS = 24 * 60 * 60 * 1000
