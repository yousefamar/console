import { hubFetch } from '../client.js'
import { output, exitWithError, info, outputLine, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

export async function agent(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'list': return agentList(args, flags)
    case 'create': return agentCreate(args, flags)
    case 'send': return agentSend(args, flags)
    case 'resume': return agentResume(args, flags)
    case 'kill': return agentKill(args, flags)
    case 'reload': return agentReload(args, flags)
    case 'interrupt': return agentInterrupt(args, flags)
    case 'approve': return agentApprove(args, flags)
    case 'deny': return agentDeny(args, flags)
    case 'tail': return agentTail(args, flags)
    case 'wait': return agentWait(args, flags)
    case 'chat': return agentChat(args, flags)
    case 'merge': return agentMerge(args, flags)
    case 'model': return agentModel(args, flags)
    case 'role': return agentRole(args, flags)
    case 'revive': return agentRevive(args, flags)
    case 'delegate': return agentDelegate(args, flags)
    case 'report': return agentReport(args, flags)
    case 'tasks': return agentTasks(args, flags)
    default:
      exitWithError('USAGE', `Unknown agent command: ${verb}. Run 'con help agent'.`, flags)
  }
}

// --------------------------------------------------------------------------
// agent chat — talk to another agent session.
//
// First turn:  con agent chat "<name>" "<message>"
//   Forks the named session (inherits its full context), injects the message,
//   waits for its reply, prints `conv: <claudeSessionId>` then the reply text.
//   The fork is a real session — visible in `con agent list`, tailable, and
//   left alive for follow-ups. The forked agent's MAIN session is untouched.
//
// Continue:    con agent chat --id <conv-id> "<message>"
//   Injects into the existing fork (resolved by claudeSessionId → live hub id,
//   so it survives hub restarts), waits for the reply, prints it.
//
// End:         con agent chat --id <conv-id> --end
//   Reaps the fork (delete_session — terminates the subprocess AND removes it
//   from the list so it can't be resumed on restart). Or just stop calling.
// --------------------------------------------------------------------------

interface HealthSession { id: string; claudeSessionId?: string; name?: string; cwd?: string; status: string }

async function resolveByName(name: string): Promise<HealthSession> {
  const health = await hubFetch<{ sessions: HealthSession[] }>('/health')
  const matches = (health.sessions || []).filter(
    (s) => s.status !== 'ended' && s.id !== 'al' && (s.name || '').toLowerCase() === name.toLowerCase(),
  )
  if (matches.length === 0) throw new Error(`No active session named "${name}". See \`con agent list\`.`)
  if (matches.length > 1) throw new Error(`Multiple active sessions named "${name}" — rename so it's unique.`)
  return matches[0]!
}

async function resolveByClaudeId(convId: string): Promise<HealthSession> {
  const health = await hubFetch<{ sessions: HealthSession[] }>('/health')
  const match = (health.sessions || []).find((s) => s.claudeSessionId === convId && s.status !== 'ended')
  if (!match) throw new Error(`Conversation ${convId} not found (the fork may have ended).`)
  return match
}

async function agentChat(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  // Positionals = tokens that are neither a --flag nor a value consumed by a
  // value-taking flag. Lets the message appear before OR after flags
  // (e.g. `chat --id X "msg"` and `chat Name "msg" --from Y` both work).
  const VALUE_FLAGS = new Set(['id', 'from', 'timeout'])
  const lead: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2).split('=')[0]!
      if (VALUE_FLAGS.has(key) && !a.includes('=')) i++ // skip its value token
      continue
    }
    lead.push(a)
  }
  const timeoutMs = opts.timeout ? parseDurationMs(opts.timeout) : 300_000
  const { streamWithSends, injectAndCapture } = await import('../ws-client.js')

  // --- Merge a conversation (fork) back into its parent, then close it ---
  if (opts.merge === 'true') {
    const convId = opts.id
    if (!convId) { exitWithError('USAGE', 'Usage: con agent chat --id <conv-id> --merge', flags); return }
    const target = await resolveByClaudeId(convId)
    await runMerge(target.id, flags)
    return
  }

  // --- End an existing conversation ---
  if (opts.end === 'true') {
    const convId = opts.id
    if (!convId) { exitWithError('USAGE', 'Usage: con agent chat --id <conv-id> --end', flags); return }
    const target = await resolveByClaudeId(convId)
    const { sendAndReceive } = await import('../ws-client.js')
    // kill_session ends the fork's subprocess but KEEPS the entry in the list so
    // its conversation stays readable (Yousef's call — don't auto-reap). The hub
    // marks it status:ended and broadcasts the updated list. To fully remove it,
    // `con agent kill <session-id>`.
    await sendAndReceive({ type: 'kill_session', sessionId: target.id }, () => false)
    output({ ended: convId }, flags)
    return
  }

  // --- Continue an existing conversation ---
  if (opts.id) {
    const message = lead.join(' ').trim()
    if (!message) { exitWithError('USAGE', 'Usage: con agent chat --id <conv-id> "<message>"', flags); return }
    const target = await resolveByClaudeId(opts.id)
    const reply = await injectAndCapture({ sessionId: target.id, message, timeoutMs })
    printConv(opts.id, reply, flags)
    return
  }

  // --- First turn: fork the named session, inject, await reply ---
  const name = lead[0]
  const message = lead.slice(1).join(' ').trim()
  if (!name || !message) {
    exitWithError('USAGE', 'Usage: con agent chat "<name>" "<message>"  (or --id <conv-id> "<message>")', flags)
    return
  }
  const target = await resolveByName(name)
  if (!target.claudeSessionId) { exitWithError('ERROR', `Session "${name}" has no Claude session id yet — let it start first.`, flags); return }

  const from = opts.from || 'another agent'
  const seed =
    `[Forked side-conversation: you've been branched from your session to talk with ${from}. ` +
    `Your main session is untouched. Reply normally — your reply is delivered back to them. ` +
    `They will continue or end this conversation.]\n\n${message}`

  // Snapshot existing ids so we can spot the new fork.
  const health = await hubFetch<{ sessions: Array<{ id: string }> }>('/health')
  const existingIds = new Set((health.sessions || []).map((s) => s.id))

  let forkHubId: string | null = null
  let convId: string | null = null
  const deltas: string[] = []
  const texts: string[] = []

  await streamWithSends({
    timeoutMs,
    initial: { type: 'fork_session', sessionId: target.id },
    onMessage: (msg, send) => {
      if (msg.type === 'session_created' && !existingIds.has(msg.sessionId) && !forkHubId) {
        forkHubId = msg.sessionId
        // Inject as soon as the fork exists — its stdin is ready on spawn, and a
        // silent fork may not emit session_init until it has input.
        send({ type: 'send_message', sessionId: forkHubId, content: seed })
        return
      }
      if (!forkHubId || msg.sessionId !== forkHubId) return
      if (msg.type === 'session_init') { convId = msg.claudeSessionId; return }
      if (msg.type === 'text_delta') deltas.push(msg.content || '')
      else if (msg.type === 'text') texts.push(msg.content || '')
      else if (msg.type === 'result') return 'stop'
      else if (msg.type === 'session_ended') return 'stop'
    },
  })

  const reply = (texts.join('\n').trim() || deltas.join('').trim())
  printConv(convId, reply, flags)
}

function printConv(convId: string | null, reply: string, flags: GlobalFlags): void {
  if (flags.json) { output({ conv: convId, reply }, flags); return }
  // First line is the conv id so the calling agent can capture it for --id;
  // a blank line then the reply text follows.
  process.stdout.write(`conv: ${convId ?? '(unknown)'}\n\n${reply || '(no reply)'}\n`)
}

function parseDurationMs(s: string): number {
  const m = s.match(/^(\d+)\s*(s|m|h)?$/)
  if (!m) return 300_000
  const n = parseInt(m[1]!, 10)
  return n * ({ s: 1000, m: 60_000, h: 3_600_000 }[m[2] || 's']!)
}

async function agentList(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)

  // Get active sessions via WebSocket message or health endpoint
  const health = await hubFetch<{ sessions: unknown[] }>('/health')
  let sessions = health.sessions

  if (opts.past) {
    // Connect to WebSocket and request past sessions
    const { sendAndReceive } = await import('../ws-client.js')
    const result = await sendAndReceive(
      { type: 'list_past_sessions', cwd: opts.cwd || process.cwd() },
      (msg: any) => msg.type === 'past_sessions',
    )
    sessions = [...sessions, ...(result?.sessions || [])]
  }

  output(sessions, flags)
}

async function agentCreate(args: string[], flags: GlobalFlags): Promise<void> {
  const prompt = args[0]
  if (!prompt) exitWithError('USAGE', 'Usage: con agent create <prompt> [--cwd <path>] [--wait]', flags)
  const opts = parseFlags(args.slice(1))

  // Get existing session IDs so we can distinguish replayed session_created from new ones
  const health = await hubFetch<{ sessions: Array<{ id: string }> }>('/health')
  const existingIds = new Set((health.sessions || []).map((s) => s.id))

  const { sendAndReceive, connectAndStream } = await import('../ws-client.js')

  // Create session — only match session_created with a NEW ID (not replayed)
  const result = await sendAndReceive(
    { type: 'create_session', prompt, cwd: opts.cwd || process.cwd() },
    (msg: any) => msg.type === 'session_created' && !existingIds.has(msg.sessionId),
  )

  if (!result) exitWithError('ERROR', 'Failed to create session', flags)

  const sessionId = result.sessionId

  if (opts.wait === 'true') {
    // Stream until result
    info(`Session ${sessionId} created. Waiting for completion...`)
    await connectAndStream({
      filter: (msg: any) => msg.sessionId === sessionId,
      onMessage: (msg: any) => {
        if (msg.type === 'text' || msg.type === 'text_delta') {
          if (!flags.json) {
            process.stderr.write(msg.content || '')
          }
        }
        if (msg.type === 'result' || msg.type === 'session_ended') {
          output(msg, flags)
          return 'stop'
        }
        if (flags.json) outputLine(msg)
      },
    })
  } else {
    output({ sessionId, status: 'created' }, flags)
  }
}

async function agentSend(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  const message = args.slice(1).join(' ')
  if (!sessionId || !message) exitWithError('USAGE', 'Usage: con agent send <session-id> <message>', flags)

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'send_message', sessionId, content: message },
    () => false, // Don't wait for response
  )
  output({ sent: true, sessionId }, flags)
}

async function agentResume(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent resume <session-id> [<prompt>]', flags)
  const opts = parseFlags(args.slice(1))
  const prompt = args[1] && !args[1].startsWith('--') ? args[1] : opts.prompt

  const { sendAndReceive } = await import('../ws-client.js')
  const result = await sendAndReceive(
    { type: 'resume_session', sessionId, prompt, cwd: opts.cwd },
    (msg: any) => msg.type === 'session_created' || msg.type === 'session_init',
  )
  output(result, flags)
}

async function agentKill(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent kill <session-id>', flags)

  // delete_session terminates the subprocess AND removes from the manifest.
  // kill_session alone left the entry to be resurrected on next hub restart —
  // not what `con agent kill` documents itself as doing (see CLAUDE.md "kill"
  // sharp-edge note: "deletes the session entry"). Use the action that
  // actually matches the documented contract.
  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'delete_session', sessionId },
    () => false,
  )
  output({ killed: sessionId }, flags)
}

// con agent reload <id|name|Al> — respawn a session's subprocess without
// bouncing the hub. Al is special-cased: reloading him re-derives his persona
// from AL.md (a genuinely fresh spawn — a plain resume keeps the old baked-in
// --append-system-prompt), and works whether he's up or already down. Generic
// sessions are resumed in place (history preserved). Mirrors the SPA's intent
// of a reloadable session; the lever for applying persona/AL.md edits.
async function agentReload(args: string[], flags: GlobalFlags): Promise<void> {
  const target = args[0]
  if (!target) exitWithError('USAGE', 'Usage: con agent reload <session-id|name|Al>', flags)
  const { sendAndReceive } = await import('../ws-client.js')

  if (target.toLowerCase() === 'al') {
    await sendAndReceive({ type: 'reload_al' }, () => false)
    output({ reloaded: 'Al', mode: 'fresh-persona-spawn' }, flags)
    return
  }

  // Resolve a live session by id or unique name, then respawn it.
  let sessionId = target
  try {
    const health = await hubFetch<{ sessions: HealthSession[] }>('/health')
    const live = (health.sessions || []).filter((s) => s.status !== 'ended')
    if (!live.some((s) => s.id === target)) {
      const named = live.filter((s) => (s.name || '').toLowerCase() === target.toLowerCase())
      if (named.length === 1) sessionId = named[0]!.id
      else if (named.length > 1) exitWithError('AMBIGUOUS', `Multiple sessions named "${target}" — use the id.`, flags)
    }
  } catch { /* /health unavailable — treat target as a raw id */ }

  await sendAndReceive({ type: 'reload_session', sessionId }, () => false)
  output({ reloaded: sessionId }, flags)
}

interface ModelState { model: string; chain: string[]; lockedByEnv: boolean }

/** `con agent model` — inspect or switch the model all hub agents spawn with.
 *  The out-of-band recovery lever when Anthropic pulls a model: change it here,
 *  no code edit, and live sessions restart onto the new model. */
async function agentModel(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'get' || sub === 'list') {
    const state = await hubFetch<ModelState>('/agents/model')
    output(state, flags)
    return
  }
  if (sub === 'set') {
    const model = args[1]
    if (!model) exitWithError('USAGE', 'Usage: con agent model set <model-id>', flags)
    const state = await hubFetch<ModelState>('/agents/model', { method: 'POST', body: { model } })
    output(state, flags)
    return
  }
  // Replace the fallback chain: con agent model chain <id1> <id2> …
  // (first id becomes the active model if the current one isn't in the chain)
  if (sub === 'chain') {
    const ids = args.slice(1).map((a) => a.trim()).filter(Boolean)
    if (ids.length === 0) exitWithError('USAGE', 'Usage: con agent model chain <model-id> [<model-id> …] (most-capable first)', flags)
    const state = await hubFetch<ModelState>('/agents/model', { method: 'POST', body: { chain: ids } })
    output(state, flags)
    return
  }
  // Per-session pin: con agent model pin <session-id|name> <model-id> | unpin <session-id|name>
  if (sub === 'pin' || sub === 'unpin') {
    const target = args[1]
    const model = sub === 'pin' ? args[2] : null
    if (!target || (sub === 'pin' && !model)) {
      exitWithError('USAGE', `Usage: con agent model ${sub === 'pin' ? 'pin <session-id|name> <model-id>' : 'unpin <session-id|name>'}`, flags)
    }
    let hubId = target!
    if (!/^session_/.test(hubId)) {
      try { hubId = (await resolveByName(target!)).id } catch { /* assume it's a hub id */ }
    }
    const { sendAndReceive, NO_RESPONSE } = await import('../ws-client.js')
    await sendAndReceive({ type: 'set_session_model', sessionId: hubId, model }, NO_RESPONSE)
    output(sub === 'pin' ? { pinned: hubId, model } : { unpinned: hubId }, flags)
    return
  }
  exitWithError('USAGE', `Unknown: con agent model ${sub}. Usage: con agent model [get | set <model-id> | chain <ids…> | pin <session> <model-id> | unpin <session>]`, flags)
}

interface RoleData { key: string; title: string; manager: string | null; goals: string[]; cwd: string | null; charter: string }

/** `con agent role` — inspect/maintain the durable org-chart roles. Charter,
 *  goals and memory are AGENT-owned (edited in the role's .md file); the CLI only
 *  reads them and writes the `manager` edge. */
async function agentRole(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'list' || sub === 'tree') {
    const data = await hubFetch('/agents/roles')
    output(data, flags)
    return
  }
  if (sub === 'get') {
    const key = args[1]
    if (!key) exitWithError('USAGE', 'Usage: con agent role get <key>', flags)
    const { roles } = await hubFetch<{ roles: RoleData[] }>('/agents/roles')
    const role = roles.find((r) => r.key === key)
    if (!role) exitWithError('NOT_FOUND', `No such role: ${key}`, flags)
    output({ ...role, file: `~/.config/console/agents/${key}.md` }, flags)
    return
  }
  if (sub === 'manager') {
    const key = args[1]
    const mgr = args[2]
    if (!key || !mgr) exitWithError('USAGE', 'Usage: con agent role manager <key> <manager-key|--root>', flags)
    const manager = (mgr === '--root' || mgr === 'root') ? null : mgr
    const data = await hubFetch('/agents/roles', { method: 'POST', body: { agentKey: key, manager } })
    output(data, flags)
    return
  }
  if (sub === 'delete') {
    const key = args[1]
    if (!key) exitWithError('USAGE', 'Usage: con agent role delete <key>', flags)
    const { sendAndReceive, NO_RESPONSE } = await import('../ws-client.js')
    await sendAndReceive({ type: 'delete_role', agentKey: key }, NO_RESPONSE)
    output({ deleted: key }, flags)
    return
  }
  exitWithError('USAGE', `Unknown: con agent role ${sub}. Usage: con agent role [list | get <key> | manager <key> <mgr|--root> | delete <key>]`, flags)
}

/** `con agent merge <session-id|conv-id|name>` — fold a child back into its parent:
 *  the child self-summarises, the digest is injected into the parent, then the
 *  child is closed. Parent = fork lineage OR the org manager edge (an org child's
 *  role is also absorbed: its sub-reports reparent up, its role is deleted). */
async function agentMerge(args: string[], flags: GlobalFlags): Promise<void> {
  const idArg = args[0]
  if (!idArg) { exitWithError('USAGE', 'Usage: con agent merge <session-id|conv-id|name>', flags); return }
  let hubId = idArg
  if (!/^session_/.test(hubId)) {
    try { hubId = (await resolveByClaudeId(idArg)).id } catch { try { hubId = (await resolveByName(idArg)).id } catch { /* assume it's already a hub id */ } }
  }
  await runMerge(hubId, flags)
}

/** Shared merge runner — waits for the fork's summary turn (up to ~90s). */
async function runMerge(hubId: string, flags: GlobalFlags): Promise<void> {
  const { sendAndReceive } = await import('../ws-client.js')
  const res = await sendAndReceive(
    { type: 'merge_session', sessionId: hubId },
    (m: any) => (m.type === 'session_merged' && m.forkId === hubId) || m.type === 'hub_error',
    95_000,
  )
  if (res.type === 'hub_error') { exitWithError('ERROR', res.message, flags); return }
  output({ merged: res.forkId, parentId: res.parentId, summary: res.summary }, flags)
}

/** `con agent revive <key>` — spawn a fresh session for a parked role (charter injected). */
async function agentRevive(args: string[], flags: GlobalFlags): Promise<void> {
  const key = args[0]
  if (!key) exitWithError('USAGE', 'Usage: con agent revive <key>', flags)
  const { sendAndReceive, NO_RESPONSE } = await import('../ws-client.js')
  await sendAndReceive({ type: 'revive_agent', agentKey: key }, NO_RESPONSE)
  output({ revived: key }, flags)
}

// --------------------------------------------------------------------------
// Delegation — `con agent delegate / report / tasks`. The org-aware comms layer:
// hand work down the tree, report results back up. Backed by /agents/tasks.
// --------------------------------------------------------------------------

interface TaskData { id: string; title: string; brief: string; fromKey: string; toKey: string; status: string; parentTaskId: string | null; chain: string[]; result: string | null; ephemeral?: boolean; createdAt: number; updatedAt: number }

/** Positionals only — skips `--flag value` pairs (parseFlags handles the flags). */
function positionalArgs(args: string[]): string[] {
  const pos: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      if (a.indexOf('=') === -1 && i + 1 < args.length && !args[i + 1]!.startsWith('--')) i++ // skip its value
    } else pos.push(a)
  }
  return pos
}

/** con agent delegate <toKey> "<brief>" [--title T] [--from <key>] [--parent <taskId>] [--ephemeral]
 *  con agent delegate "<brief>" --new "<title>" [--cwd <dir>] [--manager <key>]  (mint a new role) */
async function agentDelegate(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const pos = positionalArgs(args)
  const toKey = opts.new ? undefined : pos[0]
  const brief = opts.new ? pos[0] : pos[1]
  if (!brief) exitWithError('USAGE', 'Usage: con agent delegate <toKey> "<brief>"  (or: con agent delegate "<brief>" --new "<title>" [--cwd <dir>] [--manager <key>])', flags)
  const body: Record<string, unknown> = { fromKey: opts.from || 'al', brief, title: opts.title }
  if (opts.parent) body.parentTaskId = opts.parent
  if (opts.ephemeral === 'true') body.ephemeral = true
  if (opts.new) body.newRole = { title: opts.new, cwd: opts.cwd, manager: opts.manager ?? undefined }
  else body.toKey = toKey
  const { task } = await hubFetch<{ task: TaskData }>('/agents/tasks', { method: 'POST', body })
  output(task, flags)
}

/** con agent report <taskId> "<result>" [--status done|blocked|failed] */
async function agentReport(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const pos = positionalArgs(args)
  const taskId = pos[0]
  const result = pos[1] ?? ''
  if (!taskId) exitWithError('USAGE', 'Usage: con agent report <taskId> "<result>" [--status done|blocked|failed]', flags)
  const status = opts.status || 'done'
  await hubFetch(`/agents/tasks/${encodeURIComponent(taskId!)}/report`, { method: 'POST', body: { result, status } })
  output({ reported: taskId, status }, flags)
}

/** con agent tasks [--open] [--assigned <key>] [--from <key>] [--children <taskId>]
 *  con agent tasks cancel <taskId> */
async function agentTasks(args: string[], flags: GlobalFlags): Promise<void> {
  if (args[0] === 'cancel') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con agent tasks cancel <taskId>', flags)
    await hubFetch(`/agents/tasks/${encodeURIComponent(id!)}`, { method: 'DELETE' })
    output({ cancelled: id }, flags)
    return
  }
  const opts = parseFlags(args)
  let { tasks } = await hubFetch<{ tasks: TaskData[] }>('/agents/tasks')
  if (opts.open === 'true') tasks = tasks.filter((t) => ['pending', 'in_progress', 'blocked'].includes(t.status))
  if (opts.assigned) tasks = tasks.filter((t) => t.toKey === opts.assigned)
  if (opts.from) tasks = tasks.filter((t) => t.fromKey === opts.from)
  if (opts.children) tasks = tasks.filter((t) => t.parentTaskId === opts.children)
  output({ tasks }, flags)
}

async function agentInterrupt(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent interrupt <session-id>', flags)

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'interrupt', sessionId },
    () => false,
  )
  output({ interrupted: sessionId }, flags)
}

async function agentApprove(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  const requestId = args[1]
  if (!sessionId || !requestId) exitWithError('USAGE', 'Usage: con agent approve <session-id> <request-id>', flags)
  const opts = parseFlags(args.slice(2))

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    {
      type: 'approve_tool',
      sessionId,
      requestId,
      modifiedInput: opts.input ? JSON.parse(opts.input) : undefined,
    },
    () => false,
  )
  output({ approved: requestId }, flags)
}

async function agentDeny(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  const requestId = args[1]
  if (!sessionId || !requestId) exitWithError('USAGE', 'Usage: con agent deny <session-id> <request-id>', flags)
  const opts = parseFlags(args.slice(2))

  const { sendAndReceive } = await import('../ws-client.js')
  await sendAndReceive(
    { type: 'deny_tool', sessionId, requestId, reason: opts.reason },
    () => false,
  )
  output({ denied: requestId }, flags)
}

async function agentTail(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent tail <session-id>', flags)

  const { connectAndStream } = await import('../ws-client.js')
  await connectAndStream({
    filter: (msg: any) => msg.sessionId === sessionId,
    onMessage: (msg: any) => {
      if (flags.json || flags.agent) {
        outputLine(msg)
      } else {
        // Human-readable streaming
        if (msg.type === 'text_delta') process.stderr.write(msg.content || '')
        else if (msg.type === 'text') process.stderr.write('\n')
        else if (msg.type === 'tool_use') process.stderr.write(`\n[tool] ${msg.toolName}: ${JSON.stringify(msg.input).slice(0, 100)}\n`)
        else if (msg.type === 'result') {
          process.stderr.write(`\n[done] cost=$${msg.cost?.toFixed(4)} tokens=${msg.totalTokens}\n`)
          return 'stop'
        }
        else if (msg.type === 'session_ended') return 'stop'
      }
    },
  })
}

async function agentWait(args: string[], flags: GlobalFlags): Promise<void> {
  const sessionId = args[0]
  if (!sessionId) exitWithError('USAGE', 'Usage: con agent wait <session-id>', flags)

  const { connectAndStream } = await import('../ws-client.js')
  await connectAndStream({
    filter: (msg: any) => msg.sessionId === sessionId && (msg.type === 'result' || msg.type === 'session_ended'),
    onMessage: (msg: any) => {
      output(msg, flags)
      return 'stop'
    },
  })
}
