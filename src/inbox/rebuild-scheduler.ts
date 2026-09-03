// Debounce with a ceiling. The Inbox rebuild is scheduled off every write to
// five source stores; a plain trailing debounce resets on each one, and the
// agent store alone writes every few hundred ms while the fleet is busy — so
// a rebuild could be pushed back indefinitely and a handled row linger for
// seconds. `maxWaitMs` bounds the wait from the FIRST pending request.

export interface Scheduler {
  schedule: () => void
  /** Pending request, not yet run. */
  pending: () => boolean
}

export function makeRebuildScheduler(
  run: () => void,
  opts: {
    debounceMs: number
    maxWaitMs: number
    setTimeout?: (fn: () => void, ms: number) => unknown
    clearTimeout?: (id: unknown) => void
    now?: () => number
  },
): Scheduler {
  const setT = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearT = opts.clearTimeout ?? ((id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>))
  const now = opts.now ?? (() => Date.now())
  let timer: unknown = null
  let firstAt: number | null = null

  const fire = () => {
    timer = null
    firstAt = null
    run()
  }

  return {
    schedule: () => {
      const t = now()
      if (firstAt === null) firstAt = t
      if (timer !== null) clearT(timer)
      const remainingCeiling = Math.max(0, firstAt + opts.maxWaitMs - t)
      timer = setT(fire, Math.min(opts.debounceMs, remainingCeiling))
    },
    pending: () => timer !== null,
  }
}
