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
  | {
      type: 'wake'
      prompt: string
      /** wake this agentKey's live session instead of the owner */
      as?: string
      /** Spawn a FRESH fork of the target per fire and wake that instead — the target's own context stays untouched; the fork is closed when its turn ends. */
      fork?: boolean
      /** Model alias/id for the fork (`haiku` for a cheap stateless handler). Only with `fork`. */
      model?: string
    }
  | { type: 'run'; cmd: string }
  | { type: 'post'; url: string; method?: string; headers?: Record<string, string> }
  | { type: 'notify'; title: string; body?: string }
  | { type: 'emit'; topic: string; data?: Record<string, unknown> }
  | { type: 'card'; project: string; text: string; column?: string; assign?: string }

export type OutcomeStage =
  | 'expired'        // expiresAt passed before it fired (or finished firing) — removed
  | 'armed'          // expectation: an --after event started a deadline
  | 'satisfied'      // expectation: the awaited event arrived before the deadline
  | 'missed'         // expectation: deadline passed with no matching event — the --else ran (or was refused)
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

export interface ExpectPending {
  armedAt: number
  deadlineAt: number
  /** The `--after` event that armed this deadline; absent for absolute ticks and armed-at-creation waits. */
  triggerEventId?: string
}

/** A listener that acts on the ABSENCE of its `on` event. `action` is the
 *  `--else`. Absolute (`by` set): at every deadline, satisfied iff a matching
 *  event arrived inside the window before it. Relative (`by` unset): an
 *  `after` event arms a deadline `withinMs` later that a matching `on` event
 *  disarms; with no `after` the deadline is armed once at creation. */
export interface Expectation {
  /** Cron expression (Europe/London), ISO datetime, or epoch ms as a string. */
  by?: string
  /** How far back from a `by` deadline a matching event still counts. Default: since the previous deadline. */
  windowMs?: number
  after?: { on: string; where: WhereClause[] }
  withinMs?: number
  /** Runs when the expectation is satisfied. */
  then?: ListenerAction
  pending: ExpectPending[]
  /** Matching `on` events, newest last; pruned past the window. Absolute bookkeeping. */
  matches: Array<{ id: string; at: number }>
  lastSatisfiedAt?: number
  lastMissedAt?: number
  satisfied: number
  missed: number
}

export interface Listener {
  id: string
  name?: string
  owner: ListenerOwner
  createdAt: number
  on: string
  where: WhereClause[]
  guard?: string
  /** Present = this rule watches for the event NOT arriving in time. */
  expect?: Expectation
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
  /** Fires left before the listener removes itself (`--once` = 1). Absent = unlimited. */
  times?: number
  /** What `times` started at, for the removal log ("fired 3/3"). */
  timesTotal?: number
  /** Self-remove at this epoch ms whether or not it ever fired — a one-off wait must not live forever. */
  expiresAt?: number
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
export const EXPIRY_SWEEP_MS = 60_000
export const MAX_EXPECT_PENDING = 50
export const MAX_EXPECT_MATCHES = 200
/** A geo expectation whose last fix is older than this at the deadline is judged on stale data. */
export const STALE_FIX_MS = 30 * 60 * 1000
