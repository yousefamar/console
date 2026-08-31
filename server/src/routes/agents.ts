// Agent session management — WebSocket message handler

import { WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session, type SessionOptions, type ImageAttachment } from '../session.js'
import type { ModelConfig } from '../model-config.js'
import { BACKEND_PRESETS, detectActiveBackend, writeBackendSettings, type AuthBackend, type BackendPreset } from '../auth-backend.js'
import { smallFastModel } from '../bedrock-profiles.js'
import { buildBoardProtocol } from '../agents/org-protocol.js'
import { isKanbanBoard } from '../kanban/board.js'
import { buildMergeRequest, buildMergeEnvelope, buildForkSeed } from '../agents/merge.js'
import type { ClientMessage, HubMessage } from '../protocol.js'
import { loadSessionHistory, listPastSessions } from '../history.js'
import { saveManifest } from '../manifest.js'
import { getLastReadIndex, setLastReadIndex } from '../read-state.js'

// Session order persistence
const CONFIG_DIR = join(homedir(), '.config', 'console')
const ORDER_FILE = join(CONFIG_DIR, 'agent-session-order.json')
const COLLAPSED_GROUPS_FILE = join(CONFIG_DIR, 'agent-collapsed-groups.json')

/** Load persisted order (stored as claudeSessionIds for stability across restarts) */
function loadOrderFromDisk(): string[] {
  if (!existsSync(ORDER_FILE)) return []
  try {
    return JSON.parse(readFileSync(ORDER_FILE, 'utf-8')) as string[]
  } catch {
    return []
  }
}

function saveOrderToDisk(order: string[]) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(ORDER_FILE, JSON.stringify(order))
  } catch { /* best effort */ }
}

/** Collapsed group cwds — keyed by absolute cwd path, stable across restarts */
export function loadCollapsedGroups(): string[] {
  if (!existsSync(COLLAPSED_GROUPS_FILE)) return []
  try {
    return JSON.parse(readFileSync(COLLAPSED_GROUPS_FILE, 'utf-8')) as string[]
  } catch {
    return []
  }
}

function saveCollapsedGroups(collapsed: string[]) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(COLLAPSED_GROUPS_FILE, JSON.stringify(collapsed))
  } catch { /* best effort */ }
}

/** Load session order and translate claudeSessionIds → hub session IDs */
export function loadSessionOrder(sessions: Map<string, Session>): string[] {
  const claudeOrder = loadOrderFromDisk()
  const claudeToHub = new Map<string, string>()
  for (const s of sessions.values()) {
    if (s.claudeSessionId) claudeToHub.set(s.claudeSessionId, s.id)
  }
  const ordered = claudeOrder.map((cid) => claudeToHub.get(cid)).filter(Boolean) as string[]

  // Al is always pinned at position 0 regardless of persisted order. The
  // permanent Console-managed Al session is the routing hub for inbound
  // WhatsApp/voice/etc.; surfacing him at the top of the agent list reflects
  // his "always-on assistant" role. Override the user's manual reorder for
  // this one slot only — any drag-reorder of Al gets stashed back to 0 on
  // the next refresh, which is the intended behaviour.
  const alHubId = findAlHubId(sessions)
  if (alHubId) {
    const without = ordered.filter((id) => id !== alHubId)
    return [alHubId, ...without]
  }

  return ordered
}

function findAlHubId(sessions: Map<string, Session>): string | undefined {
  for (const s of sessions.values()) {
    if (s.name === 'Al' && s.status !== 'ended') return s.id
  }
  return undefined
}

/** Translate hub session IDs → claudeSessionIds and persist */
function saveSessionOrder(hubOrder: string[], sessions: Map<string, Session>) {
  const claudeOrder: string[] = []
  for (const hubId of hubOrder) {
    const session = sessions.get(hubId)
    if (session?.claudeSessionId) claudeOrder.push(session.claudeSessionId)
  }
  saveOrderToDisk(claudeOrder)
}

type LogFn = (msg: string) => void
type TruncateFn = (str: string, max: number) => string

export interface AgentContext {
  sessions: Map<string, Session>
  clients: Set<WebSocket>
  cwd: string
  log: LogFn
  truncate: TruncateFn
  /** Fire a push notification for an `@amar` attention event (agents.ts has no
   *  direct pushServer; index.ts wires this to the push channel). */
  notifyAttention?: (sessionId: string, name: string, snippet: string) => void
  /** Cancel the phone notification when the marker is cleared. */
  clearAttentionPush?: (sessionId: string) => void
  /** Runtime agent-model config + fallback chain (model-config.ts). */
  modelConfig: ModelConfig
  /** Force a fresh Al spawn (re-derive persona). Wired in index.ts to
   *  `reloadAlSession`; used by the `reload_al` client message. */
  reloadAl?: () => Promise<Session | null>
  /** Re-key a merged-away child's active hub crons onto its parent's session so
   *  they survive the child being killed. Wired in index.ts to
   *  `HubCronScheduler.reassignSession`; returns the number of tasks moved. */
  reassignCron?: (fromClaudeSessionId: string, toClaudeSessionId: string) => number
  /** Absolute vault root (index.ts wires noteStore.vaultPath) — lets a role
   *  spawn name its project's kanban board in the system prompt. */
  vaultPath?: string
}

/** Restart every live session onto the currently-resolved model. Used after a
 *  manual model switch and after an auto-fallback so the whole fleet heals at
 *  once rather than one-failure-at-a-time. Resume-silent preserves history. */
export function restartAllSessionsForModel(ctx: AgentContext) {
  for (const s of ctx.sessions.values()) {
    if (s.status === 'ended') continue
    // Sessions pinned to their own model don't follow hub-wide changes.
    if (s.modelOverride) continue
    // Fast path: switch the live subprocess's model in place via the CLI's
    // set_model control verb — no respawn, no context re-read, ~instant for
    // the whole fleet. Falls back to the kill+respawn cycle when the process
    // can't take it (dead, pre-init, running a turn that ignores it, timeout).
    const target = ctx.modelConfig.getModel()
    void s.setModelLive(target).then((ok) => {
      if (!ok) s.restartForModelChange()
    })
  }
}

/** Force every live session to respawn (never the in-place set_model fast
 *  path). Required for a BACKEND switch: each `claude` subprocess resolves its
 *  backend from `~/.claude/settings.json` env at its OWN startup — an
 *  already-running process can't pick up a rewritten env file, so `set_model`
 *  alone would leave it authenticated against the OLD backend while trying the
 *  NEW backend's model id (400). Model-only changes should keep using
 *  `restartAllSessionsForModel`'s fast path; only use this for `applyBackendSwitch`. */
function forceRestartAllSessionsForBackend(ctx: AgentContext) {
  for (const s of ctx.sessions.values()) {
    if (s.status === 'ended') continue
    s.restartForModelChange() // no-ops for hibernated/hibernating sessions — they resolve fresh at wake
  }
}

/** Switch the auth backend (Claude Max subscription ↔ Amazon Bedrock): rewrite
 *  settings.json's env, swap the model chain to that backend's verified id
 *  format, and force every live session to respawn. See auth-backend.ts for
 *  why this can't use the model-only fast path. */
export function applyBackendSwitch(ctx: AgentContext, backend: AuthBackend): BackendPreset {
  const preset = BACKEND_PRESETS[backend]
  writeBackendSettings(backend)
  ctx.modelConfig.setChain(preset.chain)
  ctx.modelConfig.setModel(preset.chain[0]!)
  // A per-session model pin carries a model id from whichever backend it was
  // set under — it won't auto-translate. Surface any that now look mismatched
  // (heuristic: a Bedrock id carries the `us.anthropic.` prefix, or IS a Bedrock
  // profile ARN if someone pinned one directly) so they get noticed instead of
  // silently 400ing after the respawn.
  const mismatched: string[] = []
  for (const s of ctx.sessions.values()) {
    const ov = s.modelOverride
    if (!ov) continue
    const looksBedrock = ov.startsWith('us.anthropic.') || ov.startsWith('arn:aws:bedrock:')
    if (looksBedrock !== (backend === 'bedrock')) mismatched.push(`${s.name ?? s.id} (pinned to '${ov}')`)
  }
  if (mismatched.length) {
    ctx.log(`[backend] WARNING: pinned session(s) using a model id from the other backend, will likely 400 until re-pinned: ${mismatched.join(', ')}`)
  }
  ctx.log(`[backend] switched to '${preset.label}' — restarting all live sessions`)
  broadcastModelState(ctx)
  forceRestartAllSessionsForBackend(ctx)
  return preset
}

/** Broadcast the current model + backend state to all clients. */
export function broadcastModelState(ctx: AgentContext, extra?: { autoFellBack?: boolean; failedModel?: string }) {
  broadcast(ctx.clients, { type: 'model_state', ...ctx.modelConfig.getState(), backend: detectActiveBackend(), ...extra })
}

/** Apply a user-driven model change: persist, broadcast, heal the fleet. */
export function applyUserModelChange(ctx: AgentContext, model: string): void {
  ctx.modelConfig.setModel(model)
  ctx.log(`[model] set to '${ctx.modelConfig.getModel()}' (user) — restarting live sessions`)
  broadcastModelState(ctx)
  restartAllSessionsForModel(ctx)
}

// --------------------------------------------------------------------------
// Session addressing. agentKey is a plain slug on the session (board `@key`
// assignment + CONSOLE_AGENT_KEY actor attribution) — no role file behind it.
// --------------------------------------------------------------------------

/** The single live (non-ended) session with this agentKey, if any. */
export function liveSessionForRole(ctx: AgentContext, agentKey: string): Session | undefined {
  for (const s of ctx.sessions.values()) {
    if (s.agentKey === agentKey && s.status !== 'ended') return s
  }
  return undefined
}

/** Mint a unique agentKey slug from a display title (collision-suffixed against
 *  live sessions). */
export function mintAgentKey(ctx: AgentContext, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
  const taken = new Set<string>()
  for (const s of ctx.sessions.values()) {
    if (s.agentKey && s.status !== 'ended') taken.add(s.agentKey)
  }
  if (!taken.has(slug)) return slug
  let n = 1
  while (taken.has(`${slug}-${n}`)) n++
  return `${slug}-${n}`
}

/** Absolute path of a project's kanban board, mirroring spaces.ts's board
 *  resolution (board.md / kanban.md by name, else first kanban-flagged .md).
 *  Sync on purpose — called at spawn time, reads at most a handful of files. */
export function findProjectBoard(vaultPath: string, slug: string): string | null {
  const dir = join(vaultPath, 'projects', slug)
  for (const name of ['board.md', 'kanban.md']) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const p = join(dir, f)
      try { if (isKanbanBoard(readFileSync(p, 'utf-8'))) return p } catch { /* skip */ }
    }
  } catch { /* no project dir */ }
  return null
}

/** Fork a live session for ONE board ticket. The fork gets its own agentKey
 *  (parent-prefixed, board-addressable) and inherits the source's project/areas
 *  binding so it stays in the same space. Returns null when the source has no
 *  claudeSessionId yet (pre-init) — caller falls back to waking the source
 *  directly. The ENVELOPE must be sent immediately after this returns:
 *  `claude --fork-session` emits no init until its first message. */
export function forkRoleSessionForTicket(ctx: AgentContext, source: Session, blockId: string, model?: string | null): Session | null {
  if (!source.claudeSessionId) return null
  const baseTitle = (source.name ?? 'agent').replace(/(\s*\(fork\))+$/, '').replace(/\s*\^[a-z0-9-]+$/, '')
  // Title = just the readable ticket id ("Bold fox (fork)") — the parent is
  // already visible via indent/filter, so repeating its name is noise. The KEY
  // stays parent-prefixed (`console-general-bold-fox-fork`): the board's
  // assignee filter groups fork keys under their root by that shape.
  const title = `${blockId.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())} (fork)`
  const forkKey = mintAgentKey(ctx, `${baseTitle} ${blockId} fork`)
  const session = createSession(ctx, {
    prompt: '',
    cwd: source.cwd,
    resume: source.claudeSessionId,
    fork: true,
    silent: true,
    name: title,
    parentClaudeSessionId: source.claudeSessionId,
    agentKey: forkKey,
    project: source.project,
    areas: source.areas,
    // Card `#model/<alias-or-id>` → per-fork model pin (a fast fix on haiku,
    // a cheap one on sonnet). Same plumbing as the session-status-bar pin.
    ...(model ? { modelOverride: model } : {}),
  })
  const created = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: '', name: title }
  session.logMessage(created)
  broadcast(ctx.clients, created)
  return session
}

function broadcast(clients: Set<WebSocket>, msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

function broadcastExcept(clients: Set<WebSocket>, sender: WebSocket, msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

function sendTo(ws: WebSocket, msg: HubMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

/** Bump session's lastReadIndex to the current log length and broadcast.
 *  Falls back to using the hub session id when claudeSessionId isn't set yet
 *  (early in session lifetime); that key gets normalized to claudeSessionId
 *  later via copyReadStateForClaudeId once it arrives.
 *
 *  Reading a session also acknowledges its `@amar` marker — answering an agent
 *  that asked for Yousef IS the acknowledgement, so the red rail and the phone
 *  notification must both go. Done hub-side (not per-client) so every client,
 *  the APK included, inherits it from one place. */
export function markSessionRead(ctx: AgentContext, session: Session) {
  const key = session.claudeSessionId ?? session.id
  const idx = session.messageLogLength
  setLastReadIndex(key, idx)
  broadcast(ctx.clients, {
    type: 'session_read_state',
    sessionId: session.id,
    lastReadIndex: idx,
    messageLogLength: idx,
  })
  if (session.needsAttention) {
    session.clearAttention() // emits session_attention(null) → broadcast + manifest
    ctx.clearAttentionPush?.(session.id)
  }
}

export function markSessionUnread(session: Session, clients: Set<WebSocket>) {
  const key = session.claudeSessionId ?? session.id
  // Roll the pointer back so the latest message counts as unread, but no further.
  const len = session.messageLogLength
  const idx = Math.max(0, len - 1)
  setLastReadIndex(key, idx)
  broadcast(clients, {
    type: 'session_read_state',
    sessionId: session.id,
    lastReadIndex: idx,
    messageLogLength: len,
  })
}

export function createSession(ctx: AgentContext, options: SessionOptions): Session {
  // Keyed sessions get the board protocol + their identity/board pointer on a
  // FRESH spawn (or a reapplyPromptOnResume reload). Plain hub-restart resumes
  // pass neither and keep their original prompt. Skipped when the caller
  // supplied its own prompt (Al's buildAlSystemPrompt already includes it).
  // Durable knowledge is NOT injected here: charters live in the project's
  // CLAUDE.md (the cwd picks it up natively) and memory is Claude Code's own
  // auto-memory dir — the hub injects only what it alone knows.
  if (options.agentKey && (!options.resume || options.reapplyPromptOnResume)) {
    if (!options.systemPrompt) {
      options.systemPrompt = buildBoardProtocol()
    }
    options.systemPrompt += `\n\n# Your identity\nYour agentKey — the \`@key\` others assign board cards to, and the actor name your \`con\` CLI calls carry — is \`${options.agentKey}\`.`
    // Name the session's project board explicitly — no discovery step needed.
    if (options.project && ctx.vaultPath) {
      const boardAbs = findProjectBoard(ctx.vaultPath, options.project)
      if (boardAbs) {
        options.systemPrompt += `\n\n# Your project board\nYour project's kanban board is \`${boardAbs}\` — add cards there (\`@key\` to assign), and work cards tagged \`@${options.agentKey}\`.`
      }
    }
  }
  const session = new Session({ ...options, cwd: options.cwd ?? ctx.cwd })

  session.on('hub_message', (msg: HubMessage) => {
    // `push` is a transport-only hint — strip it before broadcasting to clients.
    if (msg.type === 'session_attention') {
      const { push, ...clientMsg } = msg
      broadcast(ctx.clients, clientMsg as HubMessage)
      if (push && msg.needsAttention) {
        ctx.notifyAttention?.(session.id, session.name ?? 'Agent', msg.needsAttention.snippet)
      }
      saveManifest(ctx.sessions) // persist needsAttention
      return
    }
    broadcast(ctx.clients, msg)
    // Save manifest on any session state change (debounced)
    if (msg.type === 'session_init' || msg.type === 'session_ended' || msg.type === 'result'
      || msg.type === 'session_queued') {
      saveManifest(ctx.sessions)
    }
  })

  session.on('exit', () => {
    saveManifest(ctx.sessions)
  })

  // A session hit a model-unavailable error. Advance the fallback chain (once
  // per dead model — reportFailure is idempotent for stale reports) and heal
  // the whole fleet; otherwise just restart this one onto the active model.
  session.on('model_failure', (failedModel: string, reason: string) => {
    // A per-session pin that failed only affects THIS session: drop the pin,
    // fall back to the hub-wide model, and leave the fleet chain alone.
    if (session.modelOverride && failedModel === session.modelOverride) {
      ctx.log(`[model] session ${session.id} pin '${failedModel}' failed (${reason}) → un-pinning, back to hub model`)
      session.modelOverride = undefined
      broadcast(ctx.clients, { type: 'error', sessionId: session.id, message: `Pinned model '${failedModel}' is unavailable — falling back to the hub model.` })
      session.restartForModelChange()
      saveManifest(ctx.sessions)
      broadcast(ctx.clients, { type: 'sessions_list', sessions: Array.from(ctx.sessions.values()).map((s) => s.getInfo()) })
      return
    }
    const res = ctx.modelConfig.reportFailure(failedModel)
    if (res.changed) {
      ctx.log(`[model] '${failedModel}' failed (${reason}) → falling back to '${res.model}'`)
      broadcastModelState(ctx, { autoFellBack: true, failedModel })
      restartAllSessionsForModel(ctx)
    } else if (res.exhausted) {
      ctx.log(`[model] '${failedModel}' failed (${reason}); fallback chain exhausted`)
      broadcast(ctx.clients, { type: 'error', sessionId: session.id, message: `Model '${failedModel}' is unavailable and the fallback chain is exhausted. Set a working model in the picker or via 'con agent model set <model>'.` })
    } else {
      // Already fell back (another session beat us to it) — catch this one up.
      session.restartForModelChange()
    }
  })

  ctx.sessions.set(session.id, session)
  // A resume already knows its claudeSessionId (a fresh spawn / fork learns it
  // from system/init instead). Bind the todo watcher now that listeners exist —
  // the ctor is too early for the initial emit to reach anyone, and a
  // restore-into-hibernation session never emits system/init at all.
  session.startTodoWatch()
  return session
}

/** Inject a message into a live session's timeline + wake it — the same path
 *  cron and Al's inbound use (broadcast user_prompt + log + write stdin).
 *  Exported for the board-dispatch wiring in index.ts. */
export function wakeSession(ctx: AgentContext, session: Session, content: string, images?: ImageAttachment[]): void {
  const msg = {
    type: 'user_prompt' as const, sessionId: session.id, content,
    ...(images?.length ? { images: images.map((i) => `data:${i.media_type};base64,${i.data}`) } : {}),
  }
  session.logMessage(msg) // stamps absIndex
  broadcast(ctx.clients, msg)
  session.sendMessage(content, images)
}


/** Inject a prompt into a session and resolve with the text of its next turn
 *  (captures streamed deltas + directly-emitted text; ends on `result`).
 *  Timeout is INACTIVITY-based, not a fixed cap: any message from the session
 *  (init, tool events, streamed text) resets the clock, so a slow turn — e.g. a
 *  hibernated fork that must first wake via --resume on a huge transcript, then
 *  run cleanup tools before replying — isn't cut off mid-work. (A fixed 60s cap
 *  here made merging any hibernated/large fork "fail": the summary arrived at
 *  ~70-290s, after captureNextTurn had already resolved empty.) `maxMs` is the
 *  hard ceiling so a wedged session can't leak the listener forever. */
function captureNextTurn(ctx: AgentContext, session: Session, prompt: string, inactivityMs: number, maxMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    let idleTimer: ReturnType<typeof setTimeout>
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, inactivityMs)
    }
    const onMsg = (m: HubMessage) => {
      armIdle() // any sign of life extends the window
      if (m.type === 'text_delta' || m.type === 'text') buf += m.content
      else if (m.type === 'result') finish()
    }
    const finish = () => {
      clearTimeout(idleTimer); clearTimeout(maxTimer)
      session.off('hub_message', onMsg)
      resolve(buf.trim())
    }
    const maxTimer = setTimeout(finish, maxMs)
    session.on('hub_message', onMsg)
    armIdle()
    wakeSession(ctx, session, prompt)
  })
}

/** Merge a fork back into its parent: ask the child to self-summarise, inject
 *  that digest into the parent, then close the child. Parent = fork lineage
 *  (`parentClaudeSessionId`, same conversation ancestry) — the only hierarchy.
 *  A SUMMARY — not the transcript — keeps the parent's context clean. */
export async function mergeIntoParent(ctx: AgentContext, childSessionId: string, timeoutMs = 120_000): Promise<{ ok: boolean; error?: string; summary?: string; parentId?: string }> {
  const child = ctx.sessions.get(childSessionId)
  if (!child) return { ok: false, error: `session not found: ${childSessionId}` }
  if (child.status === 'running') return { ok: false, error: 'child is busy; wait for its current turn to finish, then merge' }

  if (!child.parentClaudeSessionId) return { ok: false, error: 'no parent to merge into (not a fork)' }
  const parent = [...ctx.sessions.values()].find((s) => s.claudeSessionId === child.parentClaudeSessionId && s.status !== 'ended')
  if (!parent) return { ok: false, error: 'parent session is not live — cannot merge' }
  if (parent.id === child.id) return { ok: false, error: 'cannot merge a session into itself' }

  const request = buildMergeRequest(parent.name ?? 'your parent')
  const summary = await captureNextTurn(ctx, child, request, timeoutMs)
  if (!summary) return { ok: false, error: 'child produced no summary (timed out) — left alive so nothing is lost' }

  wakeSession(ctx, parent, buildMergeEnvelope(child.name ?? 'fork', summary, 'fork'))

  // Absorb the child's live hub crons into the parent so they don't orphan
  // (and auto-disable after 10 "session not found" misses) when the child dies.
  // The child's claudeSessionId is stable — it's been running. The parent's may
  // not be set yet if it was just revived from parked, so defer to its next
  // session_init in that case (crons fire minutes apart; the csid arrives first).
  const childCsid = child.claudeSessionId
  if (childCsid && ctx.reassignCron) {
    const absorb = (parentCsid: string) => {
      const n = ctx.reassignCron!(childCsid, parentCsid)
      if (n) ctx.log(`[merge] absorbed ${n} cron task(s): ${childCsid} → ${parentCsid}`)
    }
    if (parent.claudeSessionId) {
      absorb(parent.claudeSessionId)
    } else {
      const p = parent
      const onInit = (m: HubMessage) => {
        if (m.type !== 'session_init') return
        p.off('hub_message', onInit)
        if (p.claudeSessionId) absorb(p.claudeSessionId)
      }
      p.on('hub_message', onInit)
      setTimeout(() => p.off('hub_message', onInit), 120_000).unref?.()
    }
  }

  try { child.kill() } catch { /* ignore */ }
  ctx.sessions.delete(child.id)
  saveManifest(ctx.sessions)
  broadcast(ctx.clients, { type: 'sessions_list', sessions: Array.from(ctx.sessions.values()).map((s) => s.getInfo()) })
  ctx.log(`[merge] fork ${child.id} → parent ${parent.id} (${summary.length}-char summary)`)
  return { ok: true, summary, parentId: parent.id }
}

/** Back-compat alias — the fork case is just one branch of mergeIntoParent now. */
export const mergeFork = mergeIntoParent

export function handleClientMessage(ctx: AgentContext, ws: WebSocket, msg: ClientMessage) {
  const { sessions, clients, log, truncate } = ctx

  switch (msg.type) {
    case 'create_session': {
      // A user-designated agent (asAgent) gets a stable agentKey minted up front
      // (board addressing + actor attribution). Ad-hoc sessions stay key-less.
      let agentKey: string | undefined
      if (msg.asAgent && msg.name?.trim()) {
        agentKey = mintAgentKey(ctx, msg.name)
      }
      const session = createSession(ctx, {
        prompt: msg.prompt,
        images: msg.images,
        cwd: msg.cwd,
        name: msg.name,
        agentKey,
        project: msg.project,
        areas: msg.areas,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: msg.prompt, ...(session.name ? { name: session.name } : {}) }
      session.logMessage(createdMsg)
      broadcast(clients, createdMsg)
      const promptMsg = { type: 'user_prompt' as const, sessionId: session.id, content: msg.prompt, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      session.logMessage(promptMsg)
      broadcast(clients, promptMsg)
      log(`Session created: ${session.id} cwd=${session.cwd} (prompt: "${truncate(msg.prompt, 50)}"${msg.images?.length ? ` +${msg.images.length} image(s)` : ''})`)
      break
    }

    case 'send_message': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      // Offline-outbox retry safety: a mobile client re-delivering a queued
      // prompt carries the same dedupeKey — drop the duplicate silently.
      if (msg.dedupeKey && session.hasSeenDedupeKey(msg.dedupeKey)) {
        return
      }
      // /clear — clear the session's message log so replays start fresh
      if (msg.content.trim() === '/clear') {
        session.clearLog()
      }
      // A real user prompt supersedes any scheduled 429/503 auto-resume.
      session.cancelTransientResume()
      const userMsg = { type: 'user_prompt' as const, sessionId: msg.sessionId, content: msg.content, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      session.logMessage(userMsg)
      broadcastExcept(clients, ws, userMsg)
      // A message typed while an ExitPlanMode approval is pending is PLAN
      // FEEDBACK, not a prompt: the CLI blocks its whole turn on the
      // control_request, so stdin text would just sit unprocessed (the
      // "frozen composer"). Deny with the message as reason — the model
      // treats it as review comments and keeps planning (terminal parity).
      // Hub-side so every client (SPA, APK, con agent send, /mic/say)
      // inherits it. AskUserQuestion keeps normal send — it has its own UI.
      const planReq = session.pendingApprovalRequest
      if (planReq?.toolName === 'ExitPlanMode' && msg.content.trim() !== '/clear') {
        const deniedMsg = { type: 'tool_denied' as const, sessionId: msg.sessionId, requestId: planReq.requestId, toolName: 'ExitPlanMode', reason: msg.content }
        session.logMessage(deniedMsg)
        broadcast(clients, deniedMsg) // incl. sender — clears its approval card
        session.denyTool(planReq.requestId, msg.content)
      } else {
        session.sendMessage(msg.content, msg.images)
      }
      // Sending a message implicitly marks the session read (chat parity).
      markSessionRead(ctx, session)
      // Capture the idle→running transition in the manifest — sendMessage
      // flips status without emitting an event, so without this the nudge
      // on hub restart would miss any mid-turn session whose last persisted
      // state was idle (from the prior `result`).
      saveManifest(sessions)
      break
    }

    case 'mark_session_read': {
      const session = sessions.get(msg.sessionId)
      if (!session) return
      markSessionRead(ctx, session)
      break
    }

    case 'mark_session_unread': {
      const session = sessions.get(msg.sessionId)
      if (!session) return
      markSessionUnread(session, clients)
      break
    }

    case 'clear_attention': {
      const session = sessions.get(msg.sessionId)
      if (!session) return
      session.clearAttention() // emits session_attention(null) → broadcast via hub_message
      ctx.clearAttentionPush?.(session.id)
      saveManifest(sessions)
      break
    }

    // Queue for turn-end (append) / edit-or-cancel the queued text. Both emit
    // session_queued → broadcast + saveManifest via the hub_message listener.
    case 'queue_message': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      session.queueMessage(msg.content)
      break
    }

    case 'set_queued_message': {
      const session = sessions.get(msg.sessionId)
      if (!session) return
      session.setQueuedMessage(msg.content)
      break
    }

    case 'approve_tool': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        log(`  ERROR: session not found!`)
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      const approvedMsg = { type: 'tool_approved' as const, sessionId: msg.sessionId, requestId: msg.requestId, toolName: '' }
      session.logMessage(approvedMsg)
      broadcast(clients, approvedMsg)
      session.approveTool(msg.requestId, msg.modifiedInput)
      saveManifest(sessions)
      break
    }

    case 'deny_tool': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      const deniedMsg = { type: 'tool_denied' as const, sessionId: msg.sessionId, requestId: msg.requestId, toolName: '', reason: msg.reason }
      session.logMessage(deniedMsg)
      broadcast(clients, deniedMsg)
      session.denyTool(msg.requestId, msg.reason)
      saveManifest(sessions)
      break
    }

    case 'interrupt': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      session.interrupt()
      break
    }

    case 'kill_session': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      session.kill()
      // A resume during a hub restart can leave a SECOND hub session sharing
      // this claudeSessionId; killing only the resolved one left the duplicate
      // lingering as a running '<name> (fork)' — the `con agent chat --end`
      // "still running" report. Mark every session with the same claudeSessionId
      // ended too, but KEEP them in the list so the conversation stays readable
      // (vs delete_session, which removes them entirely).
      if (session.claudeSessionId) {
        for (const s of sessions.values()) {
          if (s !== session && s.claudeSessionId === session.claudeSessionId) s.kill()
        }
      }
      // Persist endedByUser even when the subprocess was already dead (no
      // exit event will fire to trigger the usual manifest save).
      saveManifest(sessions)
      // Broadcast so clients (SPA sidebar) reflect the ended status immediately;
      // the old handler mutated state silently and left clients showing 'running'.
      broadcast(clients, { type: 'sessions_list', sessions: Array.from(sessions.values()).map((s) => s.getInfo()) })
      log(`Session killed: ${session.id}`)
      break
    }

    case 'delete_session': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      try { session.kill() } catch {}
      sessions.delete(msg.sessionId)
      // Duplicate guard: resume_session can create a second hub session for
      // the same claudeSessionId. Deleting only one would let the survivor
      // re-write the manifest entry and resurrect the session on restart.
      if (session.claudeSessionId) {
        for (const [id, s] of sessions) {
          if (s.claudeSessionId === session.claudeSessionId) {
            try { s.kill() } catch {}
            sessions.delete(id)
          }
        }
      }
      saveManifest(sessions)
      const remaining = Array.from(sessions.values()).map((s) => s.getInfo())
      broadcast(clients, { type: 'sessions_list', sessions: remaining })
      log(`Session deleted: ${session.id}`)
      break
    }

    case 'reload_session': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      // Al keeps its bespoke persona path (buildAlSystemPrompt) — route to reloadAl.
      if (session.agentKey === 'al' && ctx.reloadAl) {
        ctx.reloadAl()
        log('Al reloaded (via reloadAl)')
      } else {
        session.reload()
        broadcast(clients, { type: 'sessions_list', sessions: Array.from(sessions.values()).map((s) => s.getInfo()) })
        log(`Session reloaded: ${session.id}`)
      }
      saveManifest(sessions)
      break
    }

    case 'reload_al': {
      if (!ctx.reloadAl) {
        sendTo(ws, { type: 'hub_error', message: 'Al reload is not wired on this hub' })
        return
      }
      ctx.reloadAl()
        .then((s) => {
          saveManifest(sessions)
          broadcast(clients, { type: 'sessions_list', sessions: Array.from(sessions.values()).map((x) => x.getInfo()) })
          log(`Al reloaded (fresh persona): ${s?.id ?? 'spawn pending'}`)
        })
        .catch((e) => {
          sendTo(ws, { type: 'hub_error', message: `Al reload failed: ${(e as Error).message}` })
        })
      break
    }

    case 'list_sessions': {
      const active = Array.from(sessions.values()).map((s) => s.getInfo())
      sendTo(ws, { type: 'sessions_list', sessions: active })
      break
    }

    case 'get_model': {
      sendTo(ws, { type: 'model_state', ...ctx.modelConfig.getState() })
      break
    }

    case 'set_model': {
      if (!msg.model?.trim()) {
        sendTo(ws, { type: 'hub_error', message: 'set_model requires a model id' })
        return
      }
      if (ctx.modelConfig.getState().lockedByEnv) {
        sendTo(ws, { type: 'hub_error', message: 'Model is locked by the CLAUDE_MODEL env var; unset it to change the model from the UI.' })
        broadcastModelState(ctx)
        return
      }
      applyUserModelChange(ctx, msg.model)
      break
    }

    case 'set_session_model': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      const model = msg.model?.trim() || null
      void session.setSessionModel(model).then((r) => {
        if (!r.ok) {
          sendTo(ws, { type: 'hub_error', message: `set session model failed: ${r.error}` })
          return
        }
        log(model
          ? `Session ${session.id} pinned to model '${model}'`
          : `Session ${session.id} model pin cleared (follows hub model)`)
        saveManifest(sessions) // persist the pin
        broadcast(clients, { type: 'sessions_list', sessions: Array.from(sessions.values()).map((s) => s.getInfo()) })
      })
      break
    }

    case 'merge_session': {
      const id = msg.sessionId
      mergeIntoParent(ctx, id)
        .then((r) => {
          if (r.ok) broadcast(clients, { type: 'session_merged', forkId: id, parentId: r.parentId!, summary: r.summary! })
          else sendTo(ws, { type: 'hub_error', message: `merge failed: ${r.error}` })
        })
        .catch((e) => sendTo(ws, { type: 'hub_error', message: `merge failed: ${(e as Error).message}` }))
      break
    }

    case 'resume_session': {
      const session = createSession(ctx, {
        prompt: msg.prompt,
        cwd: msg.cwd,
        resume: msg.sessionId,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: msg.prompt }
      session.logMessage(createdMsg)
      broadcast(clients, createdMsg)
      log(`Session resumed: ${session.id} cwd=${session.cwd} (claude session: ${msg.sessionId})`)

      if (msg.cwd) {
        const history = loadSessionHistory(msg.sessionId, msg.cwd)
        if (history.length > 0) {
          const historyMsg = { type: 'session_history' as const, sessionId: session.id, messages: history }
          broadcast(clients, historyMsg)
          log(`  Loaded ${history.length} history messages`)
        }
      }
      break
    }

    case 'list_past_sessions': {
      listPastSessions(msg.cwd).then((pastSessions) => {
        sendTo(ws, { type: 'past_sessions', sessions: pastSessions })
      }).catch((err) => {
        log(`Failed to list past sessions: ${(err as Error).message}`)
        sendTo(ws, { type: 'past_sessions', sessions: [] })
      })
      break
    }

    case 'get_session_history': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      if (session.claudeSessionId) {
        const history = loadSessionHistory(session.claudeSessionId, session.cwd)
        if (history.length > 0) {
          sendTo(ws, { type: 'session_history', sessionId: session.id, messages: history })
        }
      }
      break
    }

    case 'rename_session': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      session.name = msg.name
      const renamedMsg = { type: 'session_renamed' as const, sessionId: session.id, name: msg.name }
      session.logMessage(renamedMsg)
      broadcast(clients, renamedMsg)
      saveManifest(sessions)
      log(`Session renamed: ${session.id} → "${msg.name}"`)
      break
    }

    case 'reorder_sessions': {
      saveSessionOrder(msg.order, sessions)
      broadcastExcept(clients, ws, { type: 'session_order', order: msg.order })
      log(`Session order updated (${msg.order.length} entries)`)
      break
    }

    case 'set_collapsed_groups': {
      saveCollapsedGroups(msg.collapsed)
      broadcastExcept(clients, ws, { type: 'collapsed_groups', collapsed: msg.collapsed })
      break
    }

    case 'fork_session': {
      const sourceSession = sessions.get(msg.sessionId)
      if (!sourceSession) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      if (!sourceSession.claudeSessionId) {
        sendTo(ws, { type: 'hub_error', message: `Session has no Claude session ID yet` })
        return
      }
      const forkCwd = msg.cwd || sourceSession.cwd
      const forkName = sourceSession.name ? `${sourceSession.name.replace(/(\s*\(fork\))+$/, '')} (fork)` : undefined
      // A seeded UI fork gets its own agentKey (board-assignable) and inherits
      // the source's space binding so it shows in the same project/area panel.
      // `con agent chat` forks pass no seed → ephemeral, key-less.
      const forkAgentKey = msg.seed ? mintAgentKey(ctx, forkName ?? 'fork') : undefined
      const session = createSession(ctx, {
        prompt: '',
        cwd: forkCwd,
        resume: sourceSession.claudeSessionId,
        fork: true,
        silent: true,
        name: forkName,
        parentClaudeSessionId: sourceSession.claudeSessionId,
        agentKey: forkAgentKey,
        project: sourceSession.project,
        areas: sourceSession.areas,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: '', name: forkName }
      session.logMessage(createdMsg)
      broadcast(clients, createdMsg)
      // Load history from source session's JSONL for the frontend
      const history = loadSessionHistory(sourceSession.claudeSessionId, forkCwd)
      if (history.length > 0) {
        const historyMsg = { type: 'session_history' as const, sessionId: session.id, messages: history }
        broadcast(clients, historyMsg)
      }
      // UI forks (seed:true) get a branch-point marker so the fork KNOWS where
      // its own work begins (the inherited history above vs its branch below).
      // CRITICAL: `claude --fork-session` emits NO `system` init — and therefore
      // never hands the hub the forked claudeSessionId — until it receives a
      // first message. So we must send the seed IMMEDIATELY (not wait for
      // session_init, which would deadlock: no message → no init → no csid → a
      // dead, unusable fork). Sending the seed both kicks the fork into
      // initialising and marks the branch point. `con agent chat` forks pass no
      // seed because they send their own richer side-conversation seed instead.
      if (msg.seed) {
        const seed = buildForkSeed(sourceSession.name ?? 'your parent')
        const pm = { type: 'user_prompt' as const, sessionId: session.id, content: seed }
        broadcast(clients, pm)
        session.logMessage(pm)
        session.sendMessage(seed)
      }
      log(`Session forked: ${session.id} from ${msg.sessionId} (claude: ${sourceSession.claudeSessionId})`)
      break
    }

    case 'generate_title': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      // Gather context: always start with the initial prompt, then add recent messages
      const logMessages = session.messageLog
        .filter((m) => m.type === 'user_prompt' || m.type === 'text')
        .slice(0, 6)
        .map((m) => ('content' in m ? (m as { content: string }).content : ''))
        .filter(Boolean)
      // Prepend initial prompt if not already the first log entry
      if (!logMessages[0] || logMessages[0] !== session.initialPrompt) {
        logMessages.unshift(session.initialPrompt)
      }
      const context = logMessages.join('\n---\n').slice(0, 2000)
      const dirName = session.cwd.split('/').pop() || ''
      // Gather existing session names for style reference
      const existingNames = Array.from(sessions.values())
        .filter((s) => s.name && s.id !== session.id)
        .map((s) => s.name!)
        .slice(0, 15)
      const styleHint = existingNames.length > 0
        ? `\n\nExisting session titles for style reference: ${existingNames.join(', ')}`
        : ''
      const prompt = `Generate a short 1-4 word title for this coding session. Reply with ONLY the title, nothing else. No quotes, no punctuation, no explanation.${styleHint}\n\nProject directory: ${dirName}\nUser's initial request: ${session.initialPrompt.slice(0, 500)}\n\nFull session context:\n${context}`
      // `smallFastModel()` = the owner-tagged Haiku profile ARN on Bedrock, so
      // these little utility calls are attributable too (a bare alias here
      // would bill untagged). No-op off Bedrock.
      execFile('claude', ['-p', '--model', smallFastModel(), prompt], { timeout: 15000 }, (err, stdout) => {
        const title = err ? null : stdout.trim().replace(/^["']|["']$/g, '').slice(0, 40)
        if (title) {
          session.name = title
          const renamedMsg = { type: 'session_renamed' as const, sessionId: session.id, name: title }
          broadcast(clients, renamedMsg)
          session.logMessage(renamedMsg)
          saveManifest(sessions)
          log(`Session title generated: ${session.id} → "${title}"`)
        } else {
          log(`Failed to generate title for ${session.id}: ${err?.message ?? 'empty response'}`)
        }
      })
      break
    }

    default:
      sendTo(ws, { type: 'hub_error', message: `Unknown message type: ${(msg as { type: string }).type}` })
  }
}
