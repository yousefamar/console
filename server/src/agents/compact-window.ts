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

import type { SpawnKind } from './effort.js'

export const COMPACT_WINDOW_MIN = 100_000
export const COMPACT_WINDOW_MAX = 1_000_000

export const DEFAULT_COMPACT_WINDOW: Record<SpawnKind, number | null> = {
  default: null,
  chatFork: null,
  fork: 400_000,
  cronFork: 400_000,
  listenerFork: 400_000,
}

export type CompactWindowReason = 'pref' | 'default'

/** The window for a spawn, or null for "leave the CLI default". */
export function resolveCompactWindow(kind: SpawnKind | null | undefined, policy: unknown): { window: number | null; reason: CompactWindowReason } {
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
}

let hooks: CompactWindowHooks = { policy: () => undefined }

export function setCompactWindowHooks(h: CompactWindowHooks): void { hooks = h }
export function compactWindowHooks(): CompactWindowHooks { return hooks }
