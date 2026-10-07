// Per-spawn reasoning-effort policy.
//
// `claude --effort <level>` is read once at process start and applies to every
// request that process makes, so the choice is made in Session.spawn() beside
// the prompt-cache TTL. Until 2026-10-01 the hub passed one value for every
// spawn (CLAUDE_EFFORT=xhigh in the pm2 env → 20,538 of 20,584 requests the
// week of 22–28 Sep ran xhigh); output+thinking was ~9% of the modelled bill
// and a per-KIND policy was sized at $150–300/wk (research/cost-review-2026-
// 09-30.md, ^spry-bear). Policy: generals / standing sessions / anything
// Yousef types into (incl. Al and his WhatsApp + voice forks) stay xhigh;
// throwaway workers — card ticket-forks, cron and listener `--fork` wakes,
// `con agent chat` forks — run high. The defaults live HERE, not in the env:
// the pm2 CLAUDE_EFFORT is no longer read. Live-tunable through the
// `cache.effort` pref ({ default, fork, cronFork, listenerFork, chatFork }),
// per card through the `#effort/<level>` board tag (a pin beats the policy).

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export function isEffort(s: unknown): s is Effort {
  return typeof s === 'string' && (EFFORTS as readonly string[]).includes(s)
}

export const SPAWN_KINDS = ['default', 'fork', 'cronFork', 'listenerFork', 'chatFork'] as const
/** What kind of session a spawn is for — fixed at creation, persisted in the manifest. */
export type SpawnKind = (typeof SPAWN_KINDS)[number]

/** The kind a RESUMED session spawns as. The manifest row is the record; with
 *  none (a killed fork resumed by name) a fork by lineage or name stays a fork —
 *  ten Astera ticket-forks resumed on 7 Oct 2026 came back 'default' → xhigh. */
export function resumedSpawnKind(prior: SpawnKind | undefined, parent?: string | null, name?: string | null): SpawnKind | undefined {
  if (prior) return prior
  return parent || / \(fork\)$/.test(name ?? '') ? 'fork' : undefined
}

export type EffortPolicy = Record<SpawnKind, Effort>

export const DEFAULT_EFFORT_POLICY: EffortPolicy = {
  default: 'xhigh',
  fork: 'high',
  cronFork: 'high',
  listenerFork: 'high',
  chatFork: 'high',
}

export type EffortReason =
  | 'pinned'   // caller fixed it for the session's life (card `#effort/<level>`)
  | 'pref'     // `cache.effort.<kind>` pref override
  | 'default'  // code default for the kind

export interface EffortInput {
  kind?: SpawnKind | null
  pin?: Effort | null
  /** The raw `cache.effort` pref value — any shape; invalid entries are ignored. */
  policy?: unknown
}

export function resolveEffort(i: EffortInput): { effort: Effort; kind: SpawnKind; reason: EffortReason } {
  const kind: SpawnKind = i.kind ?? 'default'
  if (isEffort(i.pin)) return { effort: i.pin, kind, reason: 'pinned' }
  const pref = i.policy && typeof i.policy === 'object' ? (i.policy as Record<string, unknown>)[kind] : undefined
  if (isEffort(pref)) return { effort: pref, kind, reason: 'pref' }
  return { effort: DEFAULT_EFFORT_POLICY[kind], kind, reason: 'default' }
}

// ---- Session ↔ hub seam, same shape as cache-ttl.ts: Session imports this
// module; index.ts installs the prefs reader + logger once at boot.

export interface EffortHooks {
  policy: () => unknown
  onSpawn?: (effort: Effort, kind: SpawnKind, reason: EffortReason, sessionLabel: string) => void
}

let hooks: EffortHooks = { policy: () => undefined }

export function setEffortHooks(h: EffortHooks): void { hooks = h }
export function effortHooks(): EffortHooks { return hooks }
