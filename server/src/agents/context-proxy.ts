// Context proxy: a loopback HTTP proxy between hub-spawned `claude` processes
// and bedrock-runtime (card ^plum-fawn, 2026-10-01).
//
// Why: 37% of the fleet's input spend is tool results older than the last few
// tool calls, re-billed on every request (scripts/spend/clear-sim.py). The API
// can clear them server-side (`context_management.edits:
// clear_tool_uses_20250919`, beta `context-management-2025-06-27`) but Claude
// Code never sends that edit, so the hub inserts it on the wire.
//
// How: sessions opted in via `context-proxy.json` are spawned with
// `ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:<port>` and
// `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1` (the CLI's own LLM-gateway mode: the
// request arrives unsigned) plus `ANTHROPIC_CUSTOM_HEADERS` naming the session.
// The proxy re-signs with SigV4 (agents/sigv4.ts) from the same AWS profile the
// CLI would have used and forwards. Every request is logged with its context
// composition (how much of the prompt is stale tool I/O) and the response's
// usage, parsed out of Bedrock's binary eventstream as it streams through.
//
// Bypass is the default: a session not listed in the config gets no env and
// never touches the proxy. `mode: "log"` forwards unmodified (measurement);
// `mode: "clear"` also injects the clearing edit. Config is re-read on change,
// so flipping a canary needs no hub restart — the header carries identity, the
// policy is looked up per request.

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { loadAwsCredentials, signV4, type AwsCredentials } from './sigv4.js'

export const SESSION_HEADER = 'x-console-session'
export const SPAWN_HEADER = 'x-console-spawn'
export const CONTEXT_BETA = 'context-management-2025-06-27'
export const CLEAR_EDIT_TYPE = 'clear_tool_uses_20250919'

export type ProxyMode = 'log' | 'clear'

export interface ClearPolicy {
  /** Most recent tool uses kept intact. */
  keep: number
  /** Also clear the tool_use parameters, not just the results. */
  clearInputs: boolean
  /** Tool names never cleared. */
  excludeTools: string[]
  /** With nothing cleared yet and a live cache, pay one deliberate clear once the
   *  clearable tool I/O exceeds this many tokens (0 = never; wait for a cold moment). */
  enterAbove: number
  /** Gap after which the prompt cache is treated as dead (ms). */
  coldAfterMs: number
}

export interface ProxyConfig {
  enabled: boolean
  /** Session names or hub ids opted in, each with a mode. `"*"` = every spawn. */
  sessions: Record<string, ProxyMode>
  policy: ClearPolicy
}

export const DEFAULT_POLICY: ClearPolicy = { keep: 10, clearInputs: false, excludeTools: [], enterAbove: 150_000, coldAfterMs: 55 * 60_000 }

/** `trigger` the API will never reach — rule 1 ("original ≤ trigger → no edit"). */
export const NO_CLEAR_TRIGGER = 50_000_000
/** `trigger` every prompt exceeds — rule 3 ("clear all but keep") fires. */
export const FORCE_CLEAR_TRIGGER = 1

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'console', 'context-proxy.json')
}

/** Config file reader with mtime caching; a missing/corrupt file = disabled. */
export class ProxyConfigStore {
  private cached: ProxyConfig = { enabled: false, sessions: {}, policy: DEFAULT_POLICY }
  private stamp = ''
  constructor(private path: string = defaultConfigPath()) {}
  get(): ProxyConfig {
    try {
      const st = statSync(this.path)
      const m = `${st.mtimeMs}:${st.size}`
      if (m !== this.stamp) {
        const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<ProxyConfig>
        this.cached = {
          enabled: raw.enabled === true,
          sessions: raw.sessions ?? {},
          policy: { ...DEFAULT_POLICY, ...(raw.policy ?? {}) },
        }
        this.stamp = m
      }
    } catch {
      this.cached = { enabled: false, sessions: {}, policy: DEFAULT_POLICY }
      this.stamp = ''
    }
    return this.cached
  }
  /** Mode for a session, by name or id. */
  modeFor(name: string | undefined, id: string): ProxyMode | null {
    const c = this.get()
    if (!c.enabled) return null
    return (name && c.sessions[name]) || c.sessions[id] || c.sessions['*'] || null
  }
}

// ---------------------------------------------------------------------------
// Request composition — what the prompt is made of, in chars.

export interface Composition {
  bytes: number
  messages: number
  toolUses: number
  chars: { system: number; tools: number; toolResult: number; toolInput: number; assistant: number; user: number; thinking: number; images: number }
  /** Tool results (and their inputs) older than the last `keep` tool uses. */
  stale: { toolResult: number; toolInput: number; n: number }
  betas: string[]
  clientEdits: string[]
}

function blockText(c: unknown): { chars: number; images: number } {
  if (typeof c === 'string') return { chars: c.length, images: 0 }
  let chars = 0, images = 0
  if (Array.isArray(c)) for (const x of c) {
    if (!x || typeof x !== 'object') continue
    const b = x as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') chars += b.text.length
    else if (b.type === 'image') images++
  }
  return { chars, images }
}

export function analyzeBody(body: Record<string, unknown>, bytes: number, keep: number): Composition {
  const chars = { system: 0, tools: 0, toolResult: 0, toolInput: 0, assistant: 0, user: 0, thinking: 0, images: 0 }
  chars.system = blockText(body.system).chars
  try { chars.tools = body.tools ? JSON.stringify(body.tools).length : 0 } catch { /* unserialisable */ }
  const results: Array<{ id: string; chars: number }> = []
  const inputs = new Map<string, number>()
  const msgs = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : []
  for (const m of msgs) {
    const content = m.content
    if (typeof content === 'string') { if (m.role === 'assistant') chars.assistant += content.length; else chars.user += content.length; continue }
    if (!Array.isArray(content)) continue
    for (const x of content) {
      if (!x || typeof x !== 'object') continue
      const b = x as Record<string, unknown>
      switch (b.type) {
        case 'text': if (m.role === 'assistant') chars.assistant += (b.text as string ?? '').length; else chars.user += (b.text as string ?? '').length; break
        case 'thinking': chars.thinking += (b.thinking as string ?? '').length; break
        case 'image': chars.images++; break
        case 'tool_use': {
          let n = 0
          try { n = JSON.stringify(b.input ?? {}).length } catch { /* ignore */ }
          chars.toolInput += n
          inputs.set(String(b.id), n)
          break
        }
        case 'tool_result': {
          const t = blockText(b.content)
          chars.toolResult += t.chars; chars.images += t.images
          results.push({ id: String(b.tool_use_id), chars: t.chars })
          break
        }
      }
    }
  }
  const old = results.length > keep ? results.slice(0, results.length - keep) : []
  const stale = { toolResult: 0, toolInput: 0, n: old.length }
  for (const r of old) { stale.toolResult += r.chars; stale.toolInput += inputs.get(r.id) ?? 0 }
  const betas = Array.isArray(body.anthropic_beta) ? (body.anthropic_beta as string[]) : []
  const cm = body.context_management as { edits?: Array<{ type?: string }> } | undefined
  const clientEdits = (cm?.edits ?? []).map((e) => String(e.type ?? '?'))
  return { bytes, messages: msgs.length, toolUses: inputs.size, chars, stale, betas, clientEdits }
}

/** Add the clearing edit (idempotent) and make sure the beta is declared in the
 *  body — Bedrock takes betas as `anthropic_beta: [...]`, not a header. */
export function injectClearEdit(body: Record<string, unknown>, p: ClearPolicy, trigger: number): boolean {
  const cm = (body.context_management ?? {}) as { edits?: Array<Record<string, unknown>> }
  const edits = Array.isArray(cm.edits) ? cm.edits : []
  if (edits.some((e) => e.type === CLEAR_EDIT_TYPE)) return false
  const edit: Record<string, unknown> = {
    type: CLEAR_EDIT_TYPE,
    trigger: { type: 'input_tokens', value: trigger },
    keep: { type: 'tool_uses', value: p.keep },
    clear_tool_inputs: p.clearInputs,
  }
  if (p.excludeTools.length) edit.exclude_tools = p.excludeTools
  body.context_management = { ...cm, edits: [...edits, edit] }
  const betas = Array.isArray(body.anthropic_beta) ? [...(body.anthropic_beta as string[])] : []
  if (!betas.includes(CONTEXT_BETA)) betas.push(CONTEXT_BETA)
  body.anthropic_beta = betas
  return true
}


// ---------------------------------------------------------------------------
// Trigger steering — measured on Bedrock 2026-10-01 (scripts/spend/context-probe.ts).
//
// The API decides the edit per request in this order:
//   1. original prompt ≤ trigger            → no edit at all (a frozen set is dropped);
//   2. a cached cleared set keeps the retained prompt ≤ trigger → reuse it, fully warm;
//   3. otherwise clear all results but `keep` → COLD write of the retained prompt.
// Rule 3 on every call is ruinous when nothing before the first cleared block is
// cached (every request a full rewrite — a fixed trigger below the uncleared
// floor does exactly that); with Claude Code's breakpoint on its fixed prefix it
// still rewrites the whole history after it. So the proxy sets the trigger per
// request: HOLD (just under last time's original) keeps a warm run on rule 2
// and lets a dead cache fall to rule 3 by itself (that rewrite was coming
// anyway); FORCE when the cache is known dead or the stale pile is worth one
// deliberate rewrite; NO_CLEAR when nothing is cleared yet and it is not.

export interface ConvState {
  /** Tokens the model saw last time (input + cache read + cache write). */
  retained: number
  /** Tokens the API reported cleared last time. */
  cleared: number
  /** Prompt chars last time, to calibrate tokens/char for this conversation. */
  chars: number
  lastAt: number
  spawn: string
  /** Hold requests since the last forced clear, and how many of them the API
   *  answered by re-clearing anyway (the cleared total moved). */
  holds: number
  reclears: number
}

export type TriggerReason = 'force-first' | 'force-cold' | 'hold' | 'refresh' | 'enter' | 'none' | 'backoff'

/** A hold that keeps getting re-cleared is paying a history rewrite every time;
 *  after this many, stop editing until the next cold moment. */
export const BACKOFF_RECLEARS = 3

export function decideTrigger(st: ConvState | undefined, now: number, spawn: string, comp: Composition, p: ClearPolicy): { trigger: number; reason: TriggerReason } {
  if (!st) return { trigger: FORCE_CLEAR_TRIGGER, reason: 'force-first' }
  const gapCold = now - st.lastAt > p.coldAfterMs
  const tokPerChar = st.chars > 0 ? (st.retained + st.cleared) / st.chars : 1 / 3.7
  const stale = (comp.stale.toolResult + (p.clearInputs ? comp.stale.toolInput : 0)) * tokPerChar
  if (st.cleared > 0 && !gapCold) {
    if (st.reclears >= BACKOFF_RECLEARS && st.reclears * 2 >= st.holds) return { trigger: NO_CLEAR_TRIGGER, reason: 'backoff' }
    // Stale results that piled up since the frozen clear: worth paying one rewrite?
    if (p.enterAbove > 0 && stale - st.cleared > p.enterAbove) return { trigger: FORCE_CLEAR_TRIGGER, reason: 'refresh' }
    // Just under last time's original: rule 1 cannot fire (this prompt is longer),
    // rule 2 holds until the growth since the clear exceeds what was cleared.
    const delta = Math.max(1000, Math.floor(st.cleared * 0.05))
    return { trigger: st.retained + st.cleared - delta, reason: 'hold' }
  }
  if (gapCold || spawn !== st.spawn) return { trigger: FORCE_CLEAR_TRIGGER, reason: 'force-cold' }
  if (p.enterAbove > 0 && stale > p.enterAbove) return { trigger: FORCE_CLEAR_TRIGGER, reason: 'enter' }
  return { trigger: NO_CLEAR_TRIGGER, reason: 'none' }
}

export function promptChars(c: Composition): number {
  const k = c.chars
  return k.system + k.tools + k.toolResult + k.toolInput + k.assistant + k.user + k.thinking + k.images * 1844 * 3.7
}

/** Identity of one conversation: the session plus the opening of its system
 *  prompt and first user message — subagents under the same session have their
 *  own prompt and must not share the parent's numbers. */
export function conversationKey(session: string, body: Record<string, unknown>): string {
  const sys = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? String((body.system[0] as { text?: string } | undefined)?.text ?? '') : ''
  const msgs = Array.isArray(body.messages) ? body.messages as Array<{ content?: unknown }> : []
  const first = msgs[0]?.content
  const head = typeof first === 'string' ? first : Array.isArray(first) ? String((first[0] as { text?: string } | undefined)?.text ?? '') : ''
  return createHash('sha1').update(session).update('\0').update(sys.slice(0, 2000)).update('\0').update(head.slice(0, 500)).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Bedrock eventstream → the usage/context_management events inside it.

export interface UsageSummary {
  input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cacheWrite5m?: number; output?: number
  stopReason?: string
  appliedEdits?: Array<Record<string, unknown>>
  exception?: string
  model?: string
}

/** Incremental parser for application/vnd.amazon.eventstream frames. Feed it
 *  every chunk of the upstream body; it decodes `chunk` payloads
 *  (`{bytes: base64(json)}`) and folds usage out of message_start/message_delta. */
export class EventStreamParser {
  private buf: Buffer = Buffer.alloc(0)
  readonly usage: UsageSummary = {}
  events = 0
  feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (this.buf.length < 16) return
      const total = this.buf.readUInt32BE(0)
      if (total < 16 || total > 64 * 1024 * 1024) { this.buf = Buffer.alloc(0); return }
      if (this.buf.length < total) return
      const headersLen = this.buf.readUInt32BE(4)
      const headers = parseHeaders(this.buf.subarray(12, 12 + headersLen))
      const payload = this.buf.subarray(12 + headersLen, total - 4)
      this.buf = this.buf.subarray(total)
      this.events++
      this.onFrame(headers, payload)
    }
  }
  private onFrame(headers: Record<string, string>, payload: Buffer): void {
    if (headers[':message-type'] === 'exception' || headers[':message-type'] === 'error') {
      this.usage.exception = `${headers[':exception-type'] ?? headers[':error-code'] ?? 'error'}: ${payload.toString('utf-8').slice(0, 300)}`
      return
    }
    if (headers[':event-type'] !== 'chunk') return
    try {
      const outer = JSON.parse(payload.toString('utf-8')) as { bytes?: string }
      if (!outer.bytes) return
      this.onEvent(JSON.parse(Buffer.from(outer.bytes, 'base64').toString('utf-8')) as Record<string, unknown>)
    } catch { /* not JSON — ignore */ }
  }
  onEvent(ev: Record<string, unknown>): void { foldEvent(this.usage, ev) }
}

export function foldEvent(u: UsageSummary, ev: Record<string, unknown>): void {
  if (ev.type === 'message_start') {
    const m = ev.message as { usage?: Record<string, unknown>; model?: string } | undefined
    if (m?.model) u.model = m.model
    foldUsage(u, m?.usage)
  } else if (ev.type === 'message_delta') {
    foldUsage(u, ev.usage as Record<string, unknown> | undefined)
    const d = ev.delta as { stop_reason?: string } | undefined
    if (d?.stop_reason) u.stopReason = d.stop_reason
    const cm = ev.context_management as { applied_edits?: Array<Record<string, unknown>> } | undefined
    if (cm?.applied_edits?.length) u.appliedEdits = cm.applied_edits
  } else if (ev.type === 'message') {
    // non-streaming response body
    foldUsage(u, ev.usage as Record<string, unknown> | undefined)
    if (typeof ev.model === 'string') u.model = ev.model
    if (typeof ev.stop_reason === 'string') u.stopReason = ev.stop_reason
    const cm = ev.context_management as { applied_edits?: Array<Record<string, unknown>> } | undefined
    if (cm?.applied_edits?.length) u.appliedEdits = cm.applied_edits
  } else if (ev.type === 'error') {
    u.exception = JSON.stringify(ev).slice(0, 300)
  }
}

function foldUsage(u: UsageSummary, usage: Record<string, unknown> | undefined): void {
  if (!usage) return
  const n = (k: string) => (typeof usage[k] === 'number' ? usage[k] as number : undefined)
  if (n('input_tokens') !== undefined) u.input = n('input_tokens')
  if (n('cache_read_input_tokens') !== undefined) u.cacheRead = n('cache_read_input_tokens')
  if (n('cache_creation_input_tokens') !== undefined) u.cacheWrite = n('cache_creation_input_tokens')
  if (n('output_tokens') !== undefined) u.output = n('output_tokens')
  const cc = usage.cache_creation as Record<string, unknown> | undefined
  if (cc) {
    if (typeof cc.ephemeral_1h_input_tokens === 'number') u.cacheWrite1h = cc.ephemeral_1h_input_tokens
    if (typeof cc.ephemeral_5m_input_tokens === 'number') u.cacheWrite5m = cc.ephemeral_5m_input_tokens
  }
}

function parseHeaders(b: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < b.length) {
    const nameLen = b[i]; i += 1
    const name = b.subarray(i, i + nameLen).toString('utf-8'); i += nameLen
    const type = b[i]; i += 1
    switch (type) {
      case 0: case 1: out[name] = String(type === 0); break           // bool true/false
      case 2: out[name] = String(b.readInt8(i)); i += 1; break
      case 3: out[name] = String(b.readInt16BE(i)); i += 2; break
      case 4: out[name] = String(b.readInt32BE(i)); i += 4; break
      case 5: out[name] = String(b.readBigInt64BE(i)); i += 8; break
      case 6: case 7: { const len = b.readUInt16BE(i); i += 2; out[name] = b.subarray(i, i + len).toString(type === 7 ? 'utf-8' : 'base64'); i += len; break }
      case 8: i += 8; break                                            // timestamp
      case 9: out[name] = b.subarray(i, i + 16).toString('hex'); i += 16; break
      default: return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The proxy server.

export interface ProxyLogEntry {
  ts: string
  session: string
  mode: ProxyMode | 'unknown'
  path: string
  status?: number
  ms: number
  model?: string
  comp?: Composition
  injected: boolean
  trigger?: number
  reason?: TriggerReason
  usage?: UsageSummary
  error?: string
}

export interface ContextProxyOptions {
  region: string
  profile: string
  config: ProxyConfigStore
  logPath: string
  log?: (msg: string) => void
  /** Override upstream for tests. */
  upstream?: { protocol: 'http:' | 'https:'; host: string; port: number }
  /** Prefer a Bedrock API key over SigV4 when set (AWS_BEARER_TOKEN_BEDROCK). */
  bearerToken?: string
}

export function bedrockHost(region: string): string { return `bedrock-runtime.${region}.amazonaws.com` }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host', 'content-length', 'authorization', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token', SESSION_HEADER, SPAWN_HEADER])

export class ContextProxy {
  private server: Server | null = null
  private agent = new HttpsAgent({ keepAlive: true, maxSockets: 64 })
  private creds: AwsCredentials | null = null
  private credsAt = 0
  readonly conversations = new Map<string, ConvState>()
  port = 0
  inFlight = 0
  constructor(private o: ContextProxyOptions) {}

  private log(msg: string): void { this.o.log?.(`[context-proxy] ${msg}`) }

  private credentials(): AwsCredentials | null {
    const now = Date.now()
    if (!this.creds || now - this.credsAt > 60_000) {
      this.creds = loadAwsCredentials(this.o.profile)
      this.credsAt = now
    }
    return this.creds
  }

  /** Binds on a loopback port (random when 0). Resolves with the port. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = createServer((req, res) => { void this.handle(req, res) })
      s.requestTimeout = 0
      s.headersTimeout = 60_000
      s.keepAliveTimeout = 65_000
      s.on('error', reject)
      s.listen(port, '127.0.0.1', () => {
        const a = s.address()
        this.port = typeof a === 'object' && a ? a.port : port
        this.server = s
        resolve(this.port)
      })
    })
  }

  close(): void { this.server?.close(); this.server = null; this.agent.destroy() }

  /** Env a spawn needs to route through this proxy. */
  envFor(sessionLabel: string, spawnId: string = String(Date.now())): Record<string, string> {
    return {
      ANTHROPIC_BEDROCK_BASE_URL: `http://127.0.0.1:${this.port}`,
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      ANTHROPIC_CUSTOM_HEADERS: `${SESSION_HEADER}: ${sessionLabel}\n${SPAWN_HEADER}: ${spawnId}`,
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = Date.now()
    const session = String(req.headers[SESSION_HEADER] ?? 'unknown')
    const entry: ProxyLogEntry = { ts: new Date(t0).toISOString(), session, mode: 'unknown', path: req.url ?? '/', ms: 0, injected: false }
    this.inFlight++
    try {
      let body = await readBody(req)
      const ct = String(req.headers['content-type'] ?? '')
      const isJson = ct.includes('json') && body.length > 1
      const cfg = this.o.config.get()
      const mode: ProxyMode = (cfg.sessions[session] ?? cfg.sessions['*'] ?? 'log')
      entry.mode = mode
      entry.model = decodeURIComponent((req.url ?? '').match(/\/model\/([^/]+)\//)?.[1] ?? '')
      let convKey: string | null = null
      if (isJson) {
        try {
          const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown>
          entry.comp = analyzeBody(parsed, body.length, cfg.policy.keep)
          if (mode === 'clear' && Array.isArray(parsed.messages)) {
            convKey = conversationKey(session, parsed)
            const spawn = String(req.headers[SPAWN_HEADER] ?? '')
            const d = decideTrigger(this.conversations.get(convKey), t0, spawn, entry.comp, cfg.policy)
            entry.trigger = d.trigger; entry.reason = d.reason
            if (injectClearEdit(parsed, cfg.policy, d.trigger)) {
              entry.injected = true
              body = Buffer.from(JSON.stringify(parsed))
            }
          }
        } catch (e) {
          entry.error = `body parse: ${(e as Error).message}`
        }
      }
      await this.forward(req, res, body, entry)
      if (convKey && entry.comp) this.remember(convKey, entry, String(req.headers[SPAWN_HEADER] ?? ''), t0)
    } catch (e) {
      entry.error = (e as Error).message
      if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json') }
      res.end(JSON.stringify({ message: `context-proxy: ${(e as Error).message}` }))
    } finally {
      this.inFlight--
      entry.ms = Date.now() - t0
      this.record(entry)
    }
  }

  private forward(req: IncomingMessage, res: ServerResponse, body: Buffer, entry: ProxyLogEntry): Promise<void> {
    const up = this.o.upstream ?? { protocol: 'https:' as const, host: bedrockHost(this.o.region), port: 443 }
    const url = new URL(req.url ?? '/', 'http://x')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k) || v === undefined) continue
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
    headers['content-length'] = String(body.length)
    let outHeaders: Record<string, string>
    if (this.o.bearerToken) {
      outHeaders = { ...headers, host: up.host, authorization: `Bearer ${this.o.bearerToken}` }
    } else {
      const creds = this.credentials()
      if (!creds) throw new Error(`no AWS credentials for profile ${this.o.profile}`)
      outHeaders = signV4({
        method: req.method ?? 'POST', host: up.host, path: url.pathname, query: url.search.slice(1) || undefined,
        headers, body, region: this.o.region, service: 'bedrock', credentials: creds,
      })
    }
    return new Promise((resolve, reject) => {
      const fn = up.protocol === 'https:' ? httpsRequest : httpRequest
      const upstream = fn({
        protocol: up.protocol, host: up.host, port: up.port, method: req.method, path: url.pathname + url.search,
        headers: outHeaders, agent: up.protocol === 'https:' ? this.agent : undefined,
      }, (ures) => {
        entry.status = ures.statusCode
        const resHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(ures.headers)) {
          if (k === 'connection' || k === 'keep-alive' || k === 'transfer-encoding' || v === undefined) continue
          resHeaders[k] = Array.isArray(v) ? v.join(', ') : v
        }
        res.writeHead(ures.statusCode ?? 502, resHeaders)
        const uct = String(ures.headers['content-type'] ?? '')
        const stream = uct.includes('eventstream') ? new EventStreamParser() : null
        const jsonChunks: Buffer[] = []
        ures.on('data', (c: Buffer) => {
          if (stream) stream.feed(c)
          else if (jsonChunks.length < 4096) jsonChunks.push(c)
          res.write(c)
        })
        ures.on('end', () => {
          if (stream) entry.usage = stream.usage
          else if (jsonChunks.length) {
            try {
              const j = JSON.parse(Buffer.concat(jsonChunks).toString('utf-8')) as Record<string, unknown>
              const u: UsageSummary = {}
              foldEvent(u, j)
              if (ures.statusCode && ures.statusCode >= 400) u.exception = JSON.stringify(j).slice(0, 300)
              entry.usage = u
            } catch { /* non-JSON body */ }
          }
          res.end()
          resolve()
        })
        ures.on('error', (e) => { res.destroy(e); reject(e) })
      })
      upstream.on('error', reject)
      req.on('close', () => { if (!res.writableEnded) upstream.destroy() })
      upstream.end(body)
    })
  }

  /** Fold the response's usage into the conversation state the next trigger is steered from. */
  remember(convKey: string, e: ProxyLogEntry, spawn: string, now: number): void {
    const u = e.usage
    if (!u || u.exception || (e.status ?? 500) >= 400) return
    const retained = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
    if (!retained) return
    const edit = u.appliedEdits?.find((a) => a.type === CLEAR_EDIT_TYPE)
    const cleared = typeof edit?.cleared_input_tokens === 'number' ? edit.cleared_input_tokens : 0
    const prev = this.conversations.get(convKey)
    let holds = 0, reclears = 0
    if (e.reason === 'hold' && prev) {
      holds = prev.holds + 1
      reclears = prev.reclears + (Math.abs(cleared - prev.cleared) > Math.max(200, prev.cleared * 0.02) ? 1 : 0)
    } else if (e.reason === 'backoff' && prev) {
      holds = prev.holds; reclears = prev.reclears
    }
    this.conversations.set(convKey, { retained, cleared, chars: e.comp ? promptChars(e.comp) : 0, lastAt: now, spawn, holds, reclears })
    if (this.conversations.size > 2000) {
      const cutoff = now - 6 * 3600_000
      for (const [k, v] of this.conversations) if (v.lastAt < cutoff) this.conversations.delete(k)
    }
  }

  private record(e: ProxyLogEntry): void {
    try {
      const dir = dirname(this.o.logPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(this.o.logPath, JSON.stringify(e) + '\n')
    } catch (err) {
      this.log(`ledger write failed: ${(err as Error).message}`)
    }
    const u = e.usage
    const edits = u?.appliedEdits?.map((a) => `${a.type}:${a.cleared_tool_uses ?? '?'}u/${a.cleared_input_tokens ?? '?'}t`).join(',')
    this.log(`${e.session} ${e.mode}${e.injected ? `+${e.reason}@${e.trigger}` : ''} ${e.status ?? 'ERR'} ${e.ms}ms ` +
      `ctx ${u ? `${(u.cacheRead ?? 0) / 1000 | 0}k rd/${(u.cacheWrite ?? 0) / 1000 | 0}k wr/${u.input ?? 0} in → ${u.output ?? 0} out` : '?'}` +
      (e.comp ? ` stale ${Math.round(e.comp.stale.toolResult / 1000)}k+${Math.round(e.comp.stale.toolInput / 1000)}k chars in ${e.comp.stale.n} old tool uses` : '') +
      (edits ? ` edits ${edits}` : '') + (u?.exception ? ` EXC ${u.exception.slice(0, 160)}` : '') + (e.error ? ` ERROR ${e.error}` : ''))
  }
}
