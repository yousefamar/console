// Native countdown timer (0x07, `BLE_REQ_PUT_COUNTDOWN_TIMER`) — pure helpers
// shared by the HTTP route, the CLI (via the route) and the ring verb.
// Layout + evidence: docs/g1-protocol.md §21. The firmware formats the value
// as hh:mm:ss with two-digit hours, so 99:59:59 is the largest sane duration.

export const COUNTDOWN_MAX_SECONDS = 99 * 3600 + 59 * 60 + 59

const UNIT_SECONDS: Record<string, number> = {
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  half: 0.5, quarter: 0.25,
}

/** "for"/"a timer for"/"of" lead-ins the ring hears before the duration. */
const LEAD_IN = /^(?:(?:a|the)\s+)?(?:(?:countdown|timer)\s+)?(?:for|of|to)?\s*/i

/**
 * Parse a spoken or typed duration into whole seconds — `10m`, `10 min`,
 * `1h30m`, `1:30:00`, `90 seconds`, `ten minutes`, `an hour and a half`,
 * `for 10 minutes`. A bare number is MINUTES (that is what "timer 10" means
 * out loud). Returns null when nothing parses or the result is 0 / too large
 * for the lens (`COUNTDOWN_MAX_SECONDS`).
 */
export function parseDuration(spoken: string): number | null {
  let s = spoken.trim().toLowerCase().replace(LEAD_IN, '').replace(/[.,!?]+$/, '').trim()
  if (!s) return null

  // Clock form: mm:ss or hh:mm:ss.
  const clock = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (clock) {
    const [, a, b, c] = clock
    const secs = c !== undefined
      ? Number(a) * 3600 + Number(b) * 60 + Number(c)
      : Number(a) * 60 + Number(b)
    return inRange(secs)
  }

  // Bare number = minutes.
  if (/^\d+(?:\.\d+)?$/.test(s)) return inRange(Math.round(Number(s) * 60))

  // Tokenise "1h30m", "10 minutes", "an hour and a half", "2 and a half hours".
  s = s.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/-/g, ' ')
  const words = s.split(/\s+/).filter((w) => w && w !== 'and')
  let total = 0
  let pending: number | null = null   // a number waiting for its unit
  let lastUnit: number | null = null  // for "an hour and a half"
  let matched = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (/^\d+(?:\.\d+)?$/.test(w)) { pending = (pending ?? 0) + Number(w); continue }
    // Articles: "half AN hour" / "an hour and A half" — only count as "one"
    // when nothing is pending and no fraction follows ("an hour" = 1 hour).
    if (w === 'a' || w === 'an') {
      const next = words[i + 1]
      if (pending === null && next !== 'half' && next !== 'quarter') pending = 1
      continue
    }
    if (w in NUMBER_WORDS) {
      const n = NUMBER_WORDS[w]!
      // "half" / "quarter" after a unit scales the LAST unit ("an hour and a half").
      if ((w === 'half' || w === 'quarter') && pending === null && lastUnit) { total += n * lastUnit; continue }
      pending = (pending ?? 0) + n
      continue
    }
    const unit = UNIT_SECONDS[w]
    if (unit !== undefined) {
      total += (pending ?? 1) * unit
      lastUnit = unit
      pending = null
      matched = true
      continue
    }
    return null   // an unknown word means this was not a duration
  }
  if (pending !== null) { total += pending * 60; matched = true }   // trailing bare number → minutes
  if (!matched) return null
  return inRange(Math.round(total))
}

function inRange(secs: number): number | null {
  return Number.isFinite(secs) && secs > 0 && secs <= COUNTDOWN_MAX_SECONDS ? secs : null
}

/** `hh:mm:ss` or `mm:ss` — how the lens shows it, for CLI/ring replies. */
export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
