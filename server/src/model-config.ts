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

/** Ordered most-capable-first. Fable 5 is intentionally NOT seeded — it was
 *  pulled; seeding a dead model would re-trigger a failure cycle on every boot.
 *  Re-add it to the top via the picker / CLI if/when it returns. */
export const DEFAULT_MODEL_CHAIN = [
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
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
}

interface PersistedState {
  model: string
  chain: string[]
}

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
    if (!cleaned.includes(this.state.model)) this.state.model = cleaned[0]!
    this.persist()
    return this.getState()
  }

  /** A session reported a model-unavailable failure. If `failed` is still the
   *  active model, advance to the next chain entry. Idempotent: a second report
   *  of an already-superseded model is a no-op (prevents fallback thrash when
   *  many sessions fail on the same dead model at once). Env-locked = no-op. */
  reportFailure(failed: string): FallbackResult {
    if (this.envModel()) return { changed: false, model: this.getModel(), exhausted: false }
    const active = this.state.model
    if (failed !== active) return { changed: false, model: active, exhausted: false }
    const idx = this.state.chain.indexOf(active)
    const next = idx >= 0 ? this.state.chain[idx + 1] : undefined
    if (!next) return { changed: false, model: active, exhausted: true }
    this.state.model = next
    this.persist()
    return { changed: true, model: next, exhausted: false }
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<PersistedState>
      if (typeof raw.model === 'string' && raw.model) this.state.model = raw.model
      if (Array.isArray(raw.chain) && raw.chain.length > 0) this.state.chain = raw.chain.filter((c): c is string => typeof c === 'string')
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
