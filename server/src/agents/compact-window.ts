// Per-spawn autocompact window (CLAUDE_CODE_AUTO_COMPACT_WINDOW).
//
// Context size is the cost multiplier: every request re-reads the whole prompt
// and every cold wake rewrites it, so a session that grows to 1M pays ~3x per
// request what one capped at 400k does. The `[1m]` argv hint is inert on CLI
// 2.1.280+ (it believes 1M natively), so the cap has to be the CLI's own
// autocompact window, read once per process from the env. CLI 2.1.292 clamps
// it to [100k, 1M] and compacts a little BELOW it (window 100k → compacted at
// 67–77k; verified 7 Oct 2026 on a throwaway haiku session, ~40–50 s each).
//
// Sized 7 Oct 2026 over 30 Sep–7 Oct (research/treasury/levers-2026-10-07.md):
// 400k for every spawn ≈ −$1.56k/wk modelled (15%), 175 extra compactions.
// Yousef chose 400k for THROWAWAY workers only (ticket, cron and listener
// forks). Generals, AL, his conversation forks and `con agent chat` forks
// (which inherit a whole transcript on purpose) keep the CLI default. Astera
// sessions start at ~168k, so never set this below ~350k fleet-wide.
// Live-tunable via the `cache.autoCompactWindow` pref ({ <kind>: tokens | 0 },
// 0 = CLI default), no restart; a new value applies at each process's next spawn.
//
// MEASURED after the first night live (8 Oct 2026, 6-7 Oct vs 8 Oct Bedrock $):
// astera $0.237 → $0.155 per request (−35%), console $0.217 → $0.130 (−40%) —
// better than the −15% modelled. But `~/proj/code/console/android` went $0.292
// → $0.943 (+223%), because a capped window can be exhausted by the session's
// own INSTRUCTIONS: that cwd loads 114k tokens of CLAUDE.md chain + auto-memory
// (90k of it the console repo's own CLAUDE.md) on top of ~29k of system prompt,
// and the CLI compacts these sessions at ~230k. Post-compaction the bundle is
// re-injected, two turns refill the window, and it compacts again — three forks
// did 27 compactions in 70 min for $62, 99% of it cold cache writes, zero
// progress. Hence the thrash rung below: the cap is a cost optimisation, so a
// session that thrashes under it must lose it rather than keep paying.

import type { SpawnKind } from './effort.js'

export const COMPACT_WINDOW_MIN = 100_000
export const COMPACT_WINDOW_MAX = 1_000_000

/** Compactions within THRASH_WINDOW_MS that mean the window is too small to work in. */
export const THRASH_COMPACTIONS = 3
export const THRASH_WINDOW_MS = 10 * 60_000

export const DEFAULT_COMPACT_WINDOW: Record<SpawnKind, number | null> = {
  default: null,
  chatFork: null,
  fork: 400_000,
  cronFork: 400_000,
  listenerFork: 400_000,
}

export type CompactWindowReason = 'pref' | 'default' | 'thrash'

/**
 *  Did this process compact so often that the window itself is the problem?
 *  `stamps` are compaction times for ONE process, newest last.
 */
export function isThrashing(stamps: number[], now: number): boolean {
  return stamps.filter((t) => now - t < THRASH_WINDOW_MS).length >= THRASH_COMPACTIONS
}

// Keyed by cwd, not by session: the cause is the instruction bundle that every
// session in that directory loads, so one fork's $20 lesson protects the rest.
// In memory only — a hub restart re-learns it for the price of 3 compactions,
// which is cheaper than persisting a guess about a tree that keeps changing.
const liftedCaps = new Set<string>()

export function liftCompactWindow(cwd: string): boolean {
  if (!cwd || liftedCaps.has(cwd)) return false
  liftedCaps.add(cwd)
  return true
}
export function isCompactWindowLifted(cwd: string | null | undefined): boolean { return !!cwd && liftedCaps.has(cwd) }
export function clearLiftedCompactWindows(): void { liftedCaps.clear() }

/** The window for a spawn, or null for "leave the CLI default". */
export function resolveCompactWindow(kind: SpawnKind | null | undefined, policy: unknown, cwd?: string | null): { window: number | null; reason: CompactWindowReason } {
  // A cwd that has already thrashed gets the CLI default whatever the policy
  // says — a cap that makes a session compact every other turn costs several
  // times what it saves, so it is not a cap worth honouring there.
  if (isCompactWindowLifted(cwd)) return { window: null, reason: 'thrash' }
  const k: SpawnKind = kind ?? 'default'
  const pref = policy && typeof policy === 'object' ? (policy as Record<string, unknown>)[k] : undefined
  if (pref === 0 || pref === null) return { window: null, reason: 'pref' }
  if (typeof pref === 'number' && Number.isFinite(pref)) {
    return { window: Math.round(Math.min(COMPACT_WINDOW_MAX, Math.max(COMPACT_WINDOW_MIN, pref))), reason: 'pref' }
  }
  return { window: DEFAULT_COMPACT_WINDOW[k] ?? null, reason: 'default' }
}

// ---- Session ↔ hub seam, same shape as effort.ts.

export interface CompactWindowHooks {
  policy: () => unknown
  onSpawn?: (window: number | null, kind: SpawnKind, reason: CompactWindowReason, sessionLabel: string) => void
  onThrash?: (cwd: string, window: number, compactions: number, sessionLabel: string) => void
}

let hooks: CompactWindowHooks = { policy: () => undefined }

export function setCompactWindowHooks(h: CompactWindowHooks): void { hooks = h }
export function compactWindowHooks(): CompactWindowHooks { return hooks }
