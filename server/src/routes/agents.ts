// Agent session management — WebSocket message handler

import { WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session, type SessionOptions } from '../session.js'
import type { ModelConfig } from '../model-config.js'
import type { AgentRegistry } from '../agents/registry.js'
import type { TaskStore, AgentTask } from '../agents/tasks.js'
import { checkDelegation, buildChain, chainLabel } from '../agents/delegation.js'
import { buildDelegationProtocol, buildDelegationEnvelope, buildReportEnvelope, buildOrgPosition, renderOrgRoster, shortDescription } from '../agents/delegation-protocol.js'
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
  /** Durable agent roles / org chart (agents/registry.ts). */
  agentRegistry: AgentRegistry
  /** Delegation task store (agents/tasks.ts). */
  tasks: TaskStore
  /** Force a fresh Al spawn (re-derive persona). Wired in index.ts to
   *  `reloadAlSession`; used by the `reload_al` client message. */
  reloadAl?: () => Promise<Session | null>
}

/** Restart every live session onto the currently-resolved model. Used after a
 *  manual model switch and after an auto-fallback so the whole fleet heals at
 *  once rather than one-failure-at-a-time. Resume-silent preserves history. */
export function restartAllSessionsForModel(ctx: AgentContext) {
  for (const s of ctx.sessions.values()) {
    if (s.status !== 'ended') s.restartForModelChange()
  }
}

/** Broadcast the current model state to all clients. */
export function broadcastModelState(ctx: AgentContext, extra?: { autoFellBack?: boolean; failedModel?: string }) {
  broadcast(ctx.clients, { type: 'model_state', ...ctx.modelConfig.getState(), ...extra })
}

/** Apply a user-driven model change: persist, broadcast, heal the fleet. */
export function applyUserModelChange(ctx: AgentContext, model: string): void {
  ctx.modelConfig.setModel(model)
  ctx.log(`[model] set to '${ctx.modelConfig.getModel()}' (user) — restarting live sessions`)
  broadcastModelState(ctx)
  restartAllSessionsForModel(ctx)
}

// --------------------------------------------------------------------------
// Org-chart roles (agents/registry.ts). reviveAgentRole/reloadAgentRole live
// here (not a separate file) to avoid a cycle with createSession.
// --------------------------------------------------------------------------

/** Broadcast the role list + derived org tree to all clients. */
export function broadcastAgentsList(ctx: AgentContext): void {
  broadcast(ctx.clients, { type: 'agents_list', roles: ctx.agentRegistry.list(), tree: ctx.agentRegistry.tree() })
}

/** The single live (non-ended) session embodying a role, if any. Enforces the
 *  ≤1-live-session-per-role invariant. */
export function liveSessionForRole(ctx: AgentContext, agentKey: string): Session | undefined {
  for (const s of ctx.sessions.values()) {
    if (s.agentKey === agentKey && s.status !== 'ended') return s
  }
  return undefined
}

/** Spawn a fresh session embodying a (parked) role, charter injected. Focuses an
 *  already-live session instead of duplicating. Returns null if the role is gone. */
export function reviveAgentRole(ctx: AgentContext, agentKey: string): Session | null {
  const role = ctx.agentRegistry.get(agentKey)
  if (!role) return null
  const existing = liveSessionForRole(ctx, agentKey)
  if (existing) return existing
  return createSession(ctx, {
    agentKey,
    cwd: role.cwd ?? ctx.cwd,
    prompt: `You are (re)starting as the "${role.title}" agent. Your charter and memory are in your system prompt above — read them, then await instructions.`,
  })
}

/** Re-derive a role from its (possibly-edited) file and fresh-spawn it. The only
 *  way to apply a changed charter, since --append-system-prompt is fresh-spawn
 *  only; the agent's ## Memory carries forward across the new conversation. */
export function reloadAgentRole(ctx: AgentContext, agentKey: string): Session | null {
  ctx.agentRegistry.load()
  if (!ctx.agentRegistry.get(agentKey)) return null
  const existing = liveSessionForRole(ctx, agentKey)
  if (existing) {
    existing.kill()
    ctx.sessions.delete(existing.id)
  }
  const session = reviveAgentRole(ctx, agentKey)
  const remaining = Array.from(ctx.sessions.values()).map((s) => s.getInfo())
  broadcast(ctx.clients, { type: 'sessions_list', sessions: remaining })
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
 *  later via copyReadStateForClaudeId once it arrives. */
export function markSessionRead(session: Session, clients: Set<WebSocket>) {
  const key = session.claudeSessionId ?? session.id
  const idx = session.messageLogLength
  setLastReadIndex(key, idx)
  broadcast(clients, {
    type: 'session_read_state',
    sessionId: session.id,
    lastReadIndex: idx,
    messageLogLength: idx,
  })
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
  // Resolve the durable role's charter into the system prompt — but only on a
  // FRESH spawn (!resume, mirroring session.ts:195, else restarts double-stack
  // --append-system-prompt), and only when the caller hasn't already supplied a
  // prompt (lets Al keep its richer buildAlSystemPrompt).
  if (options.agentKey && !options.resume) {
    // Charter + delegation verbs only when the caller didn't supply a prompt
    // (Al passes his own richer buildAlSystemPrompt, which already includes them).
    if (!options.systemPrompt) {
      const charter = ctx.agentRegistry.resolveCharter(options.agentKey)
      if (charter) options.systemPrompt = `${charter}\n\n${buildDelegationProtocol()}`
    }
    // Every role spawn — INCLUDING Al — gets its org position: the full roster
    // (everyone's NAMES, to locate anyone) + short DESCRIPTIONS of just its
    // immediate neighbours (manager above + direct reports below).
    const role = ctx.agentRegistry.get(options.agentKey)
    if (role) {
      const manager = role.manager ? ctx.agentRegistry.get(role.manager) : null
      const reports = ctx.agentRegistry.list().filter((r) => r.manager === options.agentKey)
      const pos = buildOrgPosition({
        self: { key: role.key, title: role.title },
        roster: renderOrgRoster(ctx.agentRegistry.tree()),
        manager: manager ? { key: manager.key, title: manager.title, desc: shortDescription(manager.charter) } : null,
        reports: reports.map((r) => ({ key: r.key, title: r.title, desc: shortDescription(r.charter), folder: r.folder })),
      })
      options.systemPrompt = options.systemPrompt ? `${options.systemPrompt}\n\n${pos}` : pos
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
    if (msg.type === 'session_init' || msg.type === 'session_ended' || msg.type === 'result') {
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
  return session
}

// --------------------------------------------------------------------------
// Delegation orchestration — touches sessions, so it lives here beside
// createSession/reviveAgentRole (the pure guards are in agents/delegation.ts).
// --------------------------------------------------------------------------

/** Broadcast the current task list to all clients. */
export function broadcastTasks(ctx: AgentContext): void {
  broadcast(ctx.clients, { type: 'tasks', tasks: ctx.tasks.list() })
}

/** Inject a message into a live session's timeline + wake it — the same path
 *  cron and Al's inbound use (broadcast user_prompt + log + write stdin). */
function wakeSession(ctx: AgentContext, session: Session, content: string): void {
  const msg = { type: 'user_prompt' as const, sessionId: session.id, content }
  broadcast(ctx.clients, msg)
  session.logMessage(msg)
  session.sendMessage(content)
}

const titleOf = (ctx: AgentContext, key: string): string => ctx.agentRegistry.get(key)?.title ?? key

export interface DelegateInput {
  fromKey: string
  toKey?: string
  newRole?: { title: string; cwd?: string; manager?: string | null }
  title?: string
  brief: string
  parentTaskId?: string | null
  ephemeral?: boolean
}

/** Delegate work down the org. Creates a task, wakes the assignee's session with
 *  a self-instructing envelope, returns the task (or an error). Async — the
 *  delegator is NOT blocked; the result arrives later via reportTask. */
export function delegateTask(ctx: AgentContext, input: DelegateInput): { task?: AgentTask; error?: string } {
  const fromKey = input.fromKey
  const parent = input.parentTaskId ? ctx.tasks.get(input.parentTaskId) : undefined
  if (input.parentTaskId && !parent) return { error: `no such parent task: ${input.parentTaskId}` }

  // Resolve / mint the assignee role.
  let toKey = input.toKey
  if (!toKey && input.newRole?.title?.trim()) {
    toKey = ctx.agentRegistry.mintKey(input.newRole.title)
    ctx.agentRegistry.create(toKey, {
      title: input.newRole.title.trim(),
      cwd: input.newRole.cwd ?? null,
      manager: input.newRole.manager ?? fromKey,
    })
    broadcastAgentsList(ctx)
  }
  if (!toKey) return { error: 'delegate needs toKey or newRole' }
  const role = ctx.agentRegistry.get(toKey)
  if (!role) return { error: `no such role: ${toKey}` }
  if (role.folder) return { error: `"${toKey}" is a folder, not an agent` }

  const chainBeforeTo = parent?.chain && parent.chain.length ? parent.chain : [fromKey]
  const check = checkDelegation(chainBeforeTo, fromKey, toKey)
  if (!check.ok) return { error: check.error }
  const chain = buildChain(parent?.chain, fromKey, toKey)
  const origin: 'human' | 'agent' = parent ? parent.origin : fromKey === 'al' ? 'human' : 'agent'

  const title = (input.title?.trim() || input.brief).slice(0, 120)
  const task = ctx.tasks.create({ title, brief: input.brief, fromKey, toKey, origin, parentTaskId: input.parentTaskId ?? null, chain, ephemeral: input.ephemeral })
  // The assignee's own reports — so if this task is really for one of them, the
  // envelope can mandate routing onward (don't let a manager short-circuit).
  const assigneeReports = ctx.agentRegistry.list().filter((r) => r.manager === toKey && !r.folder).map((r) => ({ key: r.key, title: r.title }))
  const envelope = buildDelegationEnvelope({ task, fromTitle: titleOf(ctx, fromKey), chainLabel: chainLabel(chain, (k) => titleOf(ctx, k), origin), reports: assigneeReports })

  if (input.ephemeral) {
    // A throwaway, role-less worker: the assignee's charter is passed explicitly
    // (no agentKey, so it dodges the ≤1-live-per-role sweep) and the envelope is
    // its opening prompt (auto-sent on spawn).
    const charter = ctx.agentRegistry.resolveCharter(toKey)
    const delegator = liveSessionForRole(ctx, fromKey)
    const worker = createSession(ctx, {
      prompt: envelope,
      cwd: role.cwd ?? ctx.cwd,
      name: `${title} ⟂`,
      systemPrompt: `${charter ?? ''}\n\n${buildDelegationProtocol()}`.trim(),
      parentClaudeSessionId: delegator?.claudeSessionId,
    })
    ctx.tasks.update(task.id, { workerSessionId: worker.id })
    const created = { type: 'session_created' as const, sessionId: worker.id, cwd: worker.cwd, prompt: envelope, ...(worker.name ? { name: worker.name } : {}) }
    broadcast(ctx.clients, created); worker.logMessage(created)
    const pm = { type: 'user_prompt' as const, sessionId: worker.id, content: envelope }
    broadcast(ctx.clients, pm); worker.logMessage(pm)
  } else {
    const worker = reviveAgentRole(ctx, toKey)
    if (!worker) return { error: `could not start ${toKey}` }
    ctx.tasks.update(task.id, { workerSessionId: worker.id })
    wakeSession(ctx, worker, envelope)
  }

  broadcast(ctx.clients, { type: 'sessions_list', sessions: Array.from(ctx.sessions.values()).map((s) => s.getInfo()) })
  broadcastTasks(ctx)
  ctx.log(`[delegate] ${fromKey} → ${toKey} (${task.id}): ${title}`)
  return { task: ctx.tasks.get(task.id)! }
}

/** Report a task result up to its delegator. Wakes the delegator's session with
 *  the report envelope; tears down an ephemeral worker once it has reported. */
export function reportTask(ctx: AgentContext, taskId: string, result: string, status: 'done' | 'blocked' | 'failed' = 'done'): { ok: boolean; error?: string } {
  const task = ctx.tasks.get(taskId)
  if (!task) return { ok: false, error: `no such task: ${taskId}` }
  ctx.tasks.update(taskId, { result, status })
  const updated = ctx.tasks.get(taskId)!

  if (task.ephemeral && task.workerSessionId && status !== 'blocked') {
    const w = ctx.sessions.get(task.workerSessionId)
    if (w) { try { w.kill() } catch { /* ignore */ } ctx.sessions.delete(w.id) }
  }

  const isAlTop = task.fromKey === 'al' && !task.parentTaskId && task.origin === 'human'
  const delegator = liveSessionForRole(ctx, task.fromKey) ?? reviveAgentRole(ctx, task.fromKey)
  if (delegator) {
    wakeSession(ctx, delegator, buildReportEnvelope({ task: updated, fromTitle: titleOf(ctx, task.toKey), isAlTop }))
  } else {
    ctx.log(`[report] ${taskId} ${status} but delegator ${task.fromKey} could not be reached`)
  }
  broadcast(ctx.clients, { type: 'sessions_list', sessions: Array.from(ctx.sessions.values()).map((s) => s.getInfo()) })
  broadcastTasks(ctx)
  ctx.log(`[report] ${task.toKey} → ${task.fromKey} (${taskId}): ${status}`)
  return { ok: true }
}

/** Watchdog: nudge in-progress tasks whose assignee has gone idle without
 *  reporting; after `maxNudges`, mark blocked and bubble a stall report. Called
 *  on an interval from index.ts. */
export function runTaskWatchdog(ctx: AgentContext, staleMs = 15 * 60_000, maxNudges = 2): void {
  const now = Date.now()
  for (const task of ctx.tasks.open()) {
    if (task.status !== 'in_progress') continue
    if (now - task.updatedAt < staleMs) continue
    const worker = task.workerSessionId ? ctx.sessions.get(task.workerSessionId) : liveSessionForRole(ctx, task.toKey)
    if (worker && worker.status === 'running') continue // still working
    const nudges = task.nudges ?? 0
    if (nudges >= maxNudges) {
      reportTask(ctx, task.id, `Stalled — no report after ${maxNudges} reminders.`, 'blocked')
      continue
    }
    ctx.tasks.update(task.id, { nudges: nudges + 1 })
    if (worker) wakeSession(ctx, worker, `[REMINDER] Task ${task.id} ("${task.title}") is still open. If done: con agent report ${task.id} "<result>". If still working, ignore this.`)
  }
}

/** Inject a prompt into a session and resolve with the text of its next turn
 *  (captures streamed deltas + directly-emitted text; ends on `result` or the
 *  timeout). Used to elicit a fork's hand-back summary at merge time. */
function captureNextTurn(ctx: AgentContext, session: Session, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    const onMsg = (m: HubMessage) => {
      if (m.type === 'text_delta' || m.type === 'text') buf += m.content
      else if (m.type === 'result') finish()
    }
    const finish = () => { clearTimeout(timer); session.off('hub_message', onMsg); resolve(buf.trim()) }
    const timer = setTimeout(finish, timeoutMs)
    session.on('hub_message', onMsg)
    wakeSession(ctx, session, prompt)
  })
}

/** Merge a fork back into its parent: ask the fork to self-summarise, inject that
 *  digest into the parent (resolved via `parentClaudeSessionId`), then kill the
 *  fork. The summary — not the transcript — keeps the parent's context clean. */
export async function mergeFork(ctx: AgentContext, forkSessionId: string, timeoutMs = 60_000): Promise<{ ok: boolean; error?: string; summary?: string; parentId?: string }> {
  const fork = ctx.sessions.get(forkSessionId)
  if (!fork) return { ok: false, error: `session not found: ${forkSessionId}` }
  const parentCsid = fork.parentClaudeSessionId
  if (!parentCsid) return { ok: false, error: 'not a fork — it has no parent to merge into' }
  const parent = [...ctx.sessions.values()].find((s) => s.claudeSessionId === parentCsid && s.status !== 'ended')
  if (!parent) return { ok: false, error: 'parent session is not live — cannot merge' }
  if (fork.status === 'running') return { ok: false, error: 'fork is busy; wait for its current turn to finish, then merge' }

  const summary = await captureNextTurn(ctx, fork, buildMergeRequest(parent.name ?? 'your parent'), timeoutMs)
  if (!summary) return { ok: false, error: 'fork produced no summary (timed out) — left alive so nothing is lost' }

  wakeSession(ctx, parent, buildMergeEnvelope(fork.name ?? 'fork', summary))
  try { fork.kill() } catch { /* ignore */ }
  ctx.sessions.delete(fork.id)
  saveManifest(ctx.sessions)
  broadcast(ctx.clients, { type: 'sessions_list', sessions: Array.from(ctx.sessions.values()).map((s) => s.getInfo()) })
  ctx.log(`[merge] fork ${fork.id} → parent ${parent.id} (${summary.length}-char summary)`)
  return { ok: true, summary, parentId: parent.id }
}

export function handleClientMessage(ctx: AgentContext, ws: WebSocket, msg: ClientMessage) {
  const { sessions, clients, log, truncate } = ctx

  switch (msg.type) {
    case 'create_session': {
      // A user-designated agent (asAgent) gets a durable role minted up front so
      // its charter is injected on this very spawn. Ad-hoc sessions stay role-less.
      let agentKey: string | undefined
      if (msg.asAgent && msg.name?.trim()) {
        agentKey = ctx.agentRegistry.mintKey(msg.name)
        ctx.agentRegistry.create(agentKey, { title: msg.name.trim(), charter: msg.prompt, cwd: msg.cwd })
        broadcastAgentsList(ctx)
      }
      const session = createSession(ctx, {
        prompt: msg.prompt,
        images: msg.images,
        cwd: msg.cwd,
        name: msg.name,
        agentKey,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: msg.prompt, ...(session.name ? { name: session.name } : {}) }
      broadcast(clients, createdMsg)
      session.logMessage(createdMsg)
      const promptMsg = { type: 'user_prompt' as const, sessionId: session.id, content: msg.prompt, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      broadcast(clients, promptMsg)
      session.logMessage(promptMsg)
      log(`Session created: ${session.id} cwd=${session.cwd} (prompt: "${truncate(msg.prompt, 50)}"${msg.images?.length ? ` +${msg.images.length} image(s)` : ''})`)
      break
    }

    case 'send_message': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      // /clear — clear the session's message log so replays start fresh
      if (msg.content.trim() === '/clear') {
        session.clearLog()
      }
      const userMsg = { type: 'user_prompt' as const, sessionId: msg.sessionId, content: msg.content, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      broadcastExcept(clients, ws, userMsg)
      session.logMessage(userMsg)
      session.sendMessage(msg.content, msg.images)
      // Sending a message implicitly marks the session read (chat parity).
      markSessionRead(session, clients)
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
      markSessionRead(session, clients)
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

    case 'approve_tool': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        log(`  ERROR: session not found!`)
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      const approvedMsg = { type: 'tool_approved' as const, sessionId: msg.sessionId, requestId: msg.requestId, toolName: '' }
      broadcast(clients, approvedMsg)
      session.logMessage(approvedMsg)
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
      broadcast(clients, deniedMsg)
      session.logMessage(deniedMsg)
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
      // Al is a role node but keeps its bespoke persona path (buildAlSystemPrompt),
      // not the generic charter — route it to reloadAl.
      if (session.agentKey === 'al' && ctx.reloadAl) {
        ctx.reloadAl()
        log('Role reloaded: al (via reloadAl)')
      } else if (session.agentKey) {
        // A role-backed session re-derives its (possibly-edited) charter via a
        // fresh spawn; a role-less session just resumes (history preserved).
        reloadAgentRole(ctx, session.agentKey)
        log(`Role reloaded: ${session.agentKey}`)
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

    case 'list_agents': {
      sendTo(ws, { type: 'agents_list', roles: ctx.agentRegistry.list(), tree: ctx.agentRegistry.tree() })
      break
    }

    case 'get_agent_role': {
      const role = ctx.agentRegistry.get(msg.agentKey)
      if (!role) { sendTo(ws, { type: 'hub_error', message: `No such role: ${msg.agentKey}` }); return }
      sendTo(ws, { type: 'agent_role', role })
      break
    }

    case 'set_manager': {
      if (!ctx.agentRegistry.has(msg.agentKey)) { sendTo(ws, { type: 'hub_error', message: `No such role: ${msg.agentKey}` }); return }
      // Guard against an obvious self-cycle; deeper cycles are broken at render.
      if (msg.manager === msg.agentKey) { sendTo(ws, { type: 'hub_error', message: 'A role cannot manage itself' }); return }
      ctx.agentRegistry.setManager(msg.agentKey, msg.manager)
      broadcastAgentsList(ctx)
      log(`[agents] ${msg.agentKey} manager → ${msg.manager ?? '(root)'}`)
      break
    }

    case 'revive_agent': {
      const session = reviveAgentRole(ctx, msg.agentKey)
      if (!session) { sendTo(ws, { type: 'hub_error', message: `No such role: ${msg.agentKey}` }); return }
      broadcast(clients, { type: 'sessions_list', sessions: Array.from(sessions.values()).map((s) => s.getInfo()) })
      log(`[agents] revived ${msg.agentKey} → ${session.id}`)
      break
    }

    case 'delete_role': {
      const live = liveSessionForRole(ctx, msg.agentKey)
      if (live) { try { live.kill() } catch {} sessions.delete(live.id) }
      ctx.agentRegistry.delete(msg.agentKey)
      saveManifest(sessions)
      broadcastAgentsList(ctx)
      broadcast(clients, { type: 'sessions_list', sessions: Array.from(sessions.values()).map((s) => s.getInfo()) })
      log(`[agents] deleted role ${msg.agentKey}`)
      break
    }

    case 'create_folder': {
      const title = msg.title?.trim() || 'New folder'
      const key = ctx.agentRegistry.mintKey(title)
      ctx.agentRegistry.create(key, { title, folder: true, manager: msg.manager ?? null })
      broadcastAgentsList(ctx)
      log(`[agents] created folder ${key} (manager: ${msg.manager ?? 'root'})`)
      break
    }

    case 'rename_role': {
      if (!ctx.agentRegistry.has(msg.agentKey)) { sendTo(ws, { type: 'hub_error', message: `No such role: ${msg.agentKey}` }); return }
      ctx.agentRegistry.setTitle(msg.agentKey, msg.title?.trim() || msg.agentKey)
      broadcastAgentsList(ctx)
      break
    }

    case 'delegate': {
      const res = delegateTask(ctx, { fromKey: msg.fromKey ?? 'al', toKey: msg.toKey, newRole: msg.newRole, title: msg.title, brief: msg.brief, parentTaskId: msg.parentTaskId, ephemeral: msg.ephemeral })
      if (res.error) { sendTo(ws, { type: 'hub_error', message: `delegate failed: ${res.error}` }); return }
      // The new task is in the broadcast `tasks` message; CLI diffs to find its id.
      break
    }

    case 'report': {
      const res = reportTask(ctx, msg.taskId, msg.result, msg.status ?? 'done')
      if (res.error) { sendTo(ws, { type: 'hub_error', message: `report failed: ${res.error}` }); return }
      break
    }

    case 'cancel_task': {
      ctx.tasks.cancel(msg.taskId)
      broadcastTasks(ctx)
      break
    }

    case 'tasks_list': {
      sendTo(ws, { type: 'tasks', tasks: ctx.tasks.list() })
      break
    }

    case 'merge_session': {
      const id = msg.sessionId
      mergeFork(ctx, id)
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
      broadcast(clients, createdMsg)
      session.logMessage(createdMsg)
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
      broadcast(clients, renamedMsg)
      session.logMessage(renamedMsg)
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
      const forkName = sourceSession.name ? `${sourceSession.name} (fork)` : undefined
      // A UI fork (seedRole) becomes its own org node reporting to the source's
      // role; the charter applies on a future fresh revive (this spawn resumes,
      // so it inherits the source's conversation + system prompt). `con agent
      // chat` forks pass no seedRole → ephemeral, role-less.
      let forkAgentKey: string | undefined
      if (msg.seedRole) {
        forkAgentKey = ctx.agentRegistry.mintKey(forkName ?? 'fork')
        ctx.agentRegistry.create(forkAgentKey, { title: forkName ?? forkAgentKey, manager: sourceSession.agentKey ?? null, cwd: forkCwd })
        broadcastAgentsList(ctx)
      }
      const session = createSession(ctx, {
        prompt: '',
        cwd: forkCwd,
        resume: sourceSession.claudeSessionId,
        fork: true,
        silent: true,
        name: forkName,
        parentClaudeSessionId: sourceSession.claudeSessionId,
        agentKey: forkAgentKey,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: '', name: forkName }
      broadcast(clients, createdMsg)
      session.logMessage(createdMsg)
      // Load history from source session's JSONL for the frontend
      const history = loadSessionHistory(sourceSession.claudeSessionId, forkCwd)
      if (history.length > 0) {
        const historyMsg = { type: 'session_history' as const, sessionId: session.id, messages: history }
        broadcast(clients, historyMsg)
      }
      // UI forks (seed:true) get a branch-point marker injected once the fork has
      // initialised — so the fork KNOWS where its own work begins (the inherited
      // history above vs its branch below). `con agent chat` forks pass no seed
      // (they inject their own richer side-conversation seed). Post-init timing
      // mirrors ensureAlSession so the message isn't lost before the subprocess
      // is ready.
      if (msg.seed) {
        const seed = buildForkSeed(sourceSession.name ?? 'your parent')
        const onInit = (m: HubMessage) => {
          if (m.type !== 'session_init') return
          session.off('hub_message', onInit)
          const pm = { type: 'user_prompt' as const, sessionId: session.id, content: seed }
          broadcast(clients, pm)
          session.logMessage(pm)
          session.sendMessage(seed)
        }
        session.on('hub_message', onInit)
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
      execFile('claude', ['-p', '--model', 'haiku', prompt], { timeout: 15000 }, (err, stdout) => {
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
