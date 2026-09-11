// Addresses: "<session8>", "<session8>/<uuid8>", "<session8>/t12", "<session8>/t12#3",
// full uuids in place of prefixes, or a pasted cite tag "[<session8> <uuid8> t12 2026-09-11 claude]".

export interface Address {
  session: string
  /** uuid prefix or "t<idx>"; '' for the whole session */
  turn: string
  /** tool event seq within the turn; -1 for none */
  seq: number
}

const CITE = /^\[\s*([0-9a-f-]{8,36})\s+([0-9a-f-]{8,36})\s+t(\d+)(?:#(\d+))?/i
const HEX = /^[0-9a-f-]+$/i

export function parseAddress(raw: string): Address {
  const text = raw.trim()
  if (!text) throw new Error('empty address')
  const cite = CITE.exec(text)
  if (cite) return { session: cite[1]!, turn: `t${cite[3]}`, seq: cite[4] !== undefined ? Number(cite[4]) : -1 }
  const body = text.replace(/^cc:\/\//, '')
  let seq = -1
  let rest = body
  const hash = body.indexOf('#')
  if (hash !== -1) {
    const n = Number(body.slice(hash + 1))
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad tool seq in "${raw}"`)
    seq = n
    rest = body.slice(0, hash)
  }
  const [session = '', turn = '', ...extra] = rest.split('/')
  if (extra.length) throw new Error(`bad address "${raw}"`)
  if (!HEX.test(session) || session.length < 4) throw new Error(`bad session id "${session}" (need at least 4 hex chars)`)
  if (turn && !(/^t\d+$/i.test(turn) || (HEX.test(turn) && turn.length >= 4))) throw new Error(`bad turn "${turn}" (uuid prefix or t<idx>)`)
  if (seq >= 0 && !turn) throw new Error(`#${seq} needs a turn: ${session}/t<idx>#${seq}`)
  return { session, turn: turn.toLowerCase(), seq }
}

export function formatAddress(a: Address): string {
  let s = a.session
  if (a.turn) s += `/${a.turn}`
  if (a.seq >= 0) s += `#${a.seq}`
  return s
}
