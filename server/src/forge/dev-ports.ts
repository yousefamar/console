// Dev-server ports for remote sessions.
//
// Each forge fork gets its own number, already forwarded back to the same port
// on the desktop, and is TOLD that number in its dispatch envelope ("run your
// dev server on PORT 5183"). Two sessions holding one number is two dev servers
// fighting over a port on the box — or one fork's specs quietly running against
// the other fork's server.
//
// Until 9 Oct 2026 the numbers in use were a Map that only ever grew and was
// empty after every hub restart, while restored sessions kept the numbers they
// had. That evening seven ports were each held by two or three live forks, and
// a hub that stayed up long enough would have run dry at forty dispatches
// (nothing ever released one). So the truth is now the sessions themselves
// (`inUse`), and the map holds only RESERVATIONS: a number promised to a key
// before a session carries it. A reservation lapses once it is old and no live
// session has the port.

export const DEV_PORT_BASE = 5180
export const DEV_PORT_TOP = 5219
/** How long a number stays promised to a key that no session took up. */
export const RESERVATION_TTL_MS = 10 * 60_000

export class DevPorts {
  private reserved = new Map<string, { port: number; at: number }>()

  constructor(
    private inUse: () => Iterable<number> = () => [],
    private readonly now: () => number = Date.now,
  ) {}

  /** Where the ports that live sessions already carry come from. */
  setInUse(fn: () => Iterable<number>): void {
    this.inUse = fn
  }

  /** The port for `key`: the one it was promised, else the lowest free one.
   *  null when the whole range is taken. */
  allocate(key: string): number | null {
    const live = new Set(this.inUse())
    this.prune(live)
    const mine = this.reserved.get(key)
    if (mine) {
      mine.at = this.now()
      return mine.port
    }
    const taken = new Set(live)
    for (const r of this.reserved.values()) taken.add(r.port)
    for (let p = DEV_PORT_BASE; p <= DEV_PORT_TOP; p++) {
      if (taken.has(p)) continue
      this.reserved.set(key, { port: p, at: this.now() })
      return p
    }
    return null
  }

  /** Claim a SPECIFIC port for `key` — a restored session keeping the number
   *  it was told. False when another key already holds it. */
  reserve(key: string, port: number): boolean {
    for (const [k, r] of this.reserved) if (r.port === port && k !== key) return false
    this.reserved.set(key, { port, at: this.now() })
    return true
  }

  /** Settle a whole restore at once. Two passes on purpose: every number goes
   *  to its FIRST holder before any duplicate is moved, so a session that has
   *  to move can never land on a number a later one rightly holds. */
  claimAll(holders: Array<{ key: string; port: number }>): Map<string, { port: number | null; changed: boolean }> {
    const out = new Map<string, { port: number | null; changed: boolean }>()
    const moved: string[] = []
    for (const h of holders) {
      if (this.reserve(h.key, h.port)) out.set(h.key, { port: h.port, changed: false })
      else moved.push(h.key)
    }
    for (const key of moved) out.set(key, { port: this.allocate(key), changed: true })
    return out
  }

  release(key: string): number | null {
    const p = this.reserved.get(key)?.port ?? null
    this.reserved.delete(key)
    return p
  }

  get(key: string): number | null {
    return this.reserved.get(key)?.port ?? null
  }

  private prune(live: Set<number>): void {
    const cutoff = this.now() - RESERVATION_TTL_MS
    for (const [k, r] of this.reserved) if (r.at < cutoff && !live.has(r.port)) this.reserved.delete(k)
  }
}

/** What a session is told, with its next message, when the port it was given
 *  turned out to be shared and it had to move (`to` null = the range is full). */
export function devPortChangedNote(from: number, to: number | null): string {
  const shared = `After a hub restart ${from} had been handed to another fork as well, so two forks were told the same port.`
  const stale = `A check you ran against http://localhost:${from} while the port was shared may have been answered by the other fork's server: re-run it if its result matters.`
  if (to === null) {
    return `[Console hub] You no longer have a dev-server port on forge. ${shared} No free port was left to move you to, so do not start a dev server on ${from}; say so on your card if you need one. ${stale}`
  }
  return `[Console hub] Your dev-server port on forge is now ${to}, not ${from}. ${shared} Use ${to} from here on: CONSOLE_DEV_PORT is already ${to}, and it is forwarded, so http://localhost:${to} is the url that reaches Yousef. ${stale}`
}
