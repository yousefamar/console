// ============================================================================
// Agent model configuration + fallback chain.
//
// Why this exists: the agent model used to be a hardcoded const in session.ts.
// When Anthropic pulled `claude-fable-5`, every spawned session errored and the
// only way to recover was editing source + restarting — an unrecoverable state
// for a running command center. This makes the model a persisted, runtime-
// configurable setting with an ordered fallback chain, so a pulled model is
// recoverable two ways:
//   1. Automatically — sessions that error with a model-unavailable signal trip
//      `reportFailure`, which advances the active model to the next chain entry.
//   2. Manually — the SPA picker / `con agent model set <m>` change it live.
//
// `CLAUDE_MODEL` (env) remains a hard break-glass override; when set it wins and
// auto-fallback is disabled (the human pinned it on purpose). `lockedByEnv` is
// surfaced so the UI can show the picker as locked rather than silently no-op.
// ============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** Ordered most-capable-first. **The correct ids depend on the auth backend**
 *  (`CLAUDE_CODE_USE_BEDROCK` in `~/.claude/settings.json`): Bedrock wants
 *  `us.anthropic.*` prefixed ids, the Max/first-party subscription wants BARE
 *  ids — the same id 400s on the other backend, so switching backends means
 *  re-seeding this chain (`con agent model chain …`) or nothing spawns. When
 *  changing either, re-verify each id with a one-shot spawn (`claude --model
 *  <id> …`) — availability differs per tier (e.g. opus-4-7 isn't served on the
 *  Max subscription; haiku needs the `-20251001` snapshot id first-party but
 *  `-20251001-v1:0` on Bedrock; sonnet-4-6 isn't on the Bedrock deployment).
 *  Current values = first-party (Max subscription), verified 2026-07-09. */
export const DEFAULT_MODEL_CHAIN = [
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]

export interface ModelConfigState {
  model: string
  chain: string[]
  lockedByEnv: boolean
}

export interface FallbackResult {
  changed: boolean
  model: string
  /** True when the active model failed and there's nothing left in the chain. */
  exhausted: boolean
  /** The burst guard tripped (or is still holding): the failures look like one
   *  fleet-wide spawn fault rather than dead models, so the chain did NOT
   *  advance. `model` is what the fleet was reverted to / held on. */
  heldAfterBurst?: boolean
}

/** Burst-guard thresholds. `session.ts` reads a pre-init exit as "this model is
 *  unavailable", so anything that kills a spawn for a NON-model reason walks the
 *  chain — and ONE session is enough to walk all of it. The loop:
 *  fail before init → reportFailure advances the chain → the hub restarts the
 *  session on the new model → `doModelRespawn` clears `modelFailureSignaled` and
 *  re-spawns with the same bad arguments → fails again. Capped only by
 *  `MAX_MODEL_RESTARTS` (6), i.e. 7 models — exactly the Bedrock chain's length.
 *
 *  6 Oct 2026, 23:36:49 → 23:37:58: all seven Bedrock entries failed `exited
 *  before init (code=1)` in 70 s and the fleet landed on haiku. The cause was a
 *  single unresumable session — a manifest row whose claudeSessionId was an
 *  8-char display prefix, so `claude --resume` rejected it every time (see
 *  manifest.ts `CLAUDE_SESSION_ID_RE`). No model was broken: the chain head
 *  answered a one-shot probe fine afterwards. Worse, the position is persisted,
 *  so the hub that booted at 23:41 came back up still on haiku, and the poison
 *  row re-spawned on every boot, ready to do it again.
 *
 *  What SET IT OFF, 2m18s earlier, was a backend switch: `[23:34:31] [failover]
 *  switching backend to bedrock` (seven_day_overage_included). A switch restarts
 *  every session onto the new backend's chain, so it re-spawns every bad row at
 *  once — which is why the walk happened then and not on an ordinary boot. The
 *  general shape outlives the specific poison: switch → restart-all → any
 *  spawn that fails for a non-model reason → chain walk. This guard is the only
 *  thing standing between that shape and the bottom of the chain.
 *
 *  Three distinct models failing inside two minutes is not three dead models. */
const BURST_WINDOW_MS = 120_000
const BURST_THRESHOLD = 3
const BURST_COOLDOWN_MS = 300_000

interface PersistedState {
  model: string
  chain: string[]
  /** The backend preset chain this chain was last seeded from (`applyPreset`).
   *  Equal to `chain` = nobody has edited it since, so a newer preset in code
   *  may replace it at boot (`reconcilePreset`). `[]` = a human set the chain
   *  (`setChain`), so it is never replaced. Absent = file predates this field. */
  presetChain?: string[]
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Heuristic: does this error/stderr text indicate the *model* is the problem
 *  (removed, renamed, unavailable, not entitled) rather than a transient API or
 *  tool error? Tight enough to avoid downgrading on unrelated failures. */
export function looksLikeModelError(text: string): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  // Must mention the model concept...
  if (!/\bmodel\b/.test(t)) return false
  // ...and a not-available signal.
  return /not\s+found|not\s+available|no longer\s+(available|supported)|does not exist|doesn'?t exist|invalid model|unknown model|unsupported model|not\s+(allowed|permitted|entitled)|deprecated|404|400|access/.test(t)
}

export class ModelConfig {
  private state: PersistedState
  /** Distinct models that failed inside the current burst window. In-memory on
   *  purpose: a burst is a transient fault, so a restart starts clean. */
  private recentFailures: Array<{ model: string; at: number }> = []
  private burstHoldUntil = 0

  constructor(
    private file: string,
    private log: (m: string) => void = () => {},
  ) {
    this.state = { model: DEFAULT_MODEL_CHAIN[0]!, chain: [...DEFAULT_MODEL_CHAIN] }
    this.load()
  }

  /** Hard break-glass override; when present it wins over persisted config. */
  private envModel(): string | undefined {
    const m = process.env.CLAUDE_MODEL?.trim()
    return m ? m : undefined
  }

  /** The model every new/restarted session spawns with. */
  getModel(): string {
    return this.envModel() ?? this.state.model ?? this.state.chain[0] ?? DEFAULT_MODEL_CHAIN[0]!
  }

  getChain(): string[] {
    // Surface the env model in the chain so the UI shows what's actually active.
    const env = this.envModel()
    if (env && !this.state.chain.includes(env)) return [env, ...this.state.chain]
    return [...this.state.chain]
  }

  getState(): ModelConfigState {
    return { model: this.getModel(), chain: this.getChain(), lockedByEnv: !!this.envModel() }
  }

  /** User-driven model change. Persisted; the model is added to the chain head
   *  if absent so a later failure can still fall back from it. No-op semantics
   *  when env-locked (config still updates so it takes effect once env clears). */
  setModel(model: string): ModelConfigState {
    const m = model.trim()
    if (!m) throw new Error('model is required')
    this.state.model = m
    if (!this.state.chain.includes(m)) this.state.chain = [m, ...this.state.chain]
    this.persist()
    if (this.envModel()) this.log(`[model] setModel('${m}') stored but CLAUDE_MODEL env override is active`)
    return this.getState()
  }

  /** Replace the fallback chain wholesale (keeps active model valid). */
  setChain(chain: string[]): ModelConfigState {
    const cleaned = chain.map((c) => c.trim()).filter(Boolean)
    if (cleaned.length === 0) throw new Error('chain must be non-empty')
    this.state.chain = cleaned
    this.state.presetChain = []
    if (!cleaned.includes(this.state.model)) this.state.model = cleaned[0]!
    this.persist()
    return this.getState()
  }

  /** Seed chain + model from a backend preset (backend switch). Remembers the
   *  preset so a later code change to it can be adopted at boot. */
  applyPreset(chain: string[]): ModelConfigState {
    this.setChain(chain)
    this.state.model = this.state.chain[0]!
    this.state.presetChain = [...this.state.chain]
    this.persist()
    return this.getState()
  }

  /** Boot: adopt `preset` when the persisted chain is an unedited copy of an
   *  older preset. Without this a preset change in code (e.g. Fable first on
   *  Max, 3 Oct) never reached the hub until the next backend switch, and a
   *  spill that returned under old code re-persisted the old chain. The model
   *  follows only if it was the old chain's head (a step-down or a human pick
   *  stays). Files from before `presetChain` existed count as preset-seeded
   *  when every entry is in the new preset. Returns true when it changed. */
  reconcilePreset(preset: string[]): boolean {
    const { chain, presetChain } = this.state
    if (sameList(chain, preset)) return false
    const unedited = presetChain
      ? presetChain.length > 0 && sameList(chain, presetChain)
      : chain.every((m) => preset.includes(m))
    if (!unedited) return false
    const oldHead = chain[0]
    this.state.chain = [...preset]
    this.state.presetChain = [...preset]
    if (this.state.model === oldHead || !preset.includes(this.state.model)) this.state.model = preset[0]!
    this.persist()
    this.log(`[model] chain updated to the current preset: ${preset.join(', ')} (model ${this.state.model})`)
    return true
  }

  /** A session reported a model-unavailable failure. If `failed` is still the
   *  active model, advance to the next chain entry. Idempotent: a second report
   *  of an already-superseded model is a no-op (prevents fallback thrash when
   *  many sessions fail on the same dead model at once). Env-locked = no-op. */
  reportFailure(failed: string): FallbackResult {
    if (this.envModel()) return { changed: false, model: this.getModel(), exhausted: false }
    const active = this.state.model
    if (failed !== active) return { changed: false, model: active, exhausted: false }
    const now = Date.now()
    // Still inside a tripped burst's cooldown: refuse to move at all. Spawns
    // keep failing loudly on one model instead of quietly descending the chain.
    if (now < this.burstHoldUntil) {
      return { changed: false, model: active, exhausted: false, heldAfterBurst: true }
    }

    this.recentFailures = this.recentFailures.filter((f) => now - f.at < BURST_WINDOW_MS)
    if (!this.recentFailures.some((f) => f.model === failed)) this.recentFailures.push({ model: failed, at: now })

    const idx = this.state.chain.indexOf(active)
    const next = idx >= 0 ? this.state.chain[idx + 1] : undefined

    if (this.recentFailures.length >= BURST_THRESHOLD) return this.holdAfterBurst(now, false)
    if (!next) {
      // End of the chain. If more than one model failed inside the window then
      // a walk really happened and every entry is "down" — a fleet-wide fault
      // by definition, so undo it rather than leaving the fleet on the tail
      // (which on Bedrock is haiku). A LONE failure with nothing left is
      // genuine exhaustion: a one-entry chain, or a human-set single model.
      if (this.recentFailures.length > 1) return this.holdAfterBurst(now, true)
      return { changed: false, model: active, exhausted: true }
    }

    this.state.model = next
    this.persist()
    return { changed: true, model: next, exhausted: false }
  }

  /** Undo a bogus chain walk: go back to the configured primary and refuse
   *  further fallback for the cooldown.
   *
   *  The primary, NOT wherever the walk had already reached. A burst means no
   *  model is actually broken, so any fallback is the wrong resting place — and
   *  a burst that begins partway down the chain (an earlier walk, or a stale
   *  first report) used to revert to that fallback and hold there. On 8 Oct
   *  2026 a pre-init spawn fault at 00:11 parked the fleet on fable-5-1, twice
   *  opus-5's price, for three days at ~$1.1k/day. */
  private holdAfterBurst(now: number, reachedEnd: boolean): FallbackResult {
    const revertTo = this.state.chain[0]!
    const count = this.recentFailures.length
    this.burstHoldUntil = now + BURST_COOLDOWN_MS
    this.recentFailures = []
    const changed = this.state.model !== revertTo
    this.state.model = revertTo
    this.persist()
    this.log(
      `[model] ${count} model(s) failed within ${Math.round(BURST_WINDOW_MS / 1000)}s`
      + `${reachedEnd ? ' and the chain reached its end' : ''} — treating this as a FLEET-WIDE spawn fault,`
      + ` not ${count} unavailable models. Reverting to '${revertTo}' and refusing further fallback for`
      + ` ${Math.round(BURST_COOLDOWN_MS / 60_000)} min. The real cause is in the [spawn-stderr] lines above.`,
    )
    return { changed, model: revertTo, exhausted: false, heldAfterBurst: true }
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<PersistedState>
      if (typeof raw.model === 'string' && raw.model) this.state.model = raw.model
      if (Array.isArray(raw.chain) && raw.chain.length > 0) this.state.chain = raw.chain.filter((c): c is string => typeof c === 'string')
      if (Array.isArray(raw.presetChain)) this.state.presetChain = raw.presetChain.filter((c): c is string => typeof c === 'string')
      // Guarantee the active model is reachable in the chain for fallback.
      if (!this.state.chain.includes(this.state.model)) this.state.chain = [this.state.model, ...this.state.chain]
    } catch (e) {
      this.log(`[model] load failed: ${(e as Error).message}`)
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      this.log(`[model] save failed: ${(e as Error).message}`)
    }
  }
}
