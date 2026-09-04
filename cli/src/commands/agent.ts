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
    case 'peek': return agentPeek(args, flags)
    case 'tail': return agentTail(args, flags)
    case 'wait': return agentWait(args, flags)
    case 'chat': return agentChat(args, flags)
    case 'merge': return agentMerge(args, flags)
    case 'model': return agentModel(args, flags)
    case 'backend': return agentBackend(args, flags)
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

interface HealthSession { id: string; claudeSessionId?: string; name?: string; agentKey?: string; cwd?: string; status: string }

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

// con agent peek — READ-ONLY look at a session's conversation. No fork, no
// injection, no state change; safe against any session including mid-turn.
// Built so Al can introspect his conversation-forks ("is there a convo I'm
// not aware of?") without disturbing them. Resolves by hub id, claudeSessionId
// (conv id), or unique name.
async function agentPeek(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const target = args.filter((a) => !a.startsWith('--') && a !== opts.n)[0]
  if (!target) exitWithError('USAGE', 'Usage: con agent peek <session-id|conv-id|name> [--n <messages>]', flags)
  const n = opts.n ? parseInt(opts.n, 10) : 20
  const peek = await hubFetch<{
    id: string; claudeSessionId: string; name?: string; status: string
    parentClaudeSessionId?: string; totalMessages: number
    messages: Array<{ type: string; content?: string; toolName?: string; input?: Record<string, unknown> }>
  }>(`/agents/peek?id=${encodeURIComponent(target)}&n=${n}`)

  if (flags.json || flags.agent) { output(peek, flags); return }
  // Human/agent-readable transcript rendering
  const head = `${peek.name ?? peek.id} — ${peek.status}${peek.parentClaudeSessionId ? ' (fork)' : ''} — showing last ${peek.messages.length}/${peek.totalMessages} messages`
  const lines = [head, '─'.repeat(Math.min(head.length, 80))]
  for (const m of peek.messages) {
    if (m.type === 'user_prompt') lines.push(`\n[user] ${(m.content ?? '').slice(0, 500)}`)
    else if (m.type === 'text') lines.push(`\n[assistant] ${(m.content ?? '').slice(0, 500)}`)
    else if (m.type === 'tool_use') lines.push(`  [tool] ${m.toolName}: ${JSON.stringify(m.input ?? {}).slice(0, 120)}`)
    // thinking + tool_result skipped in the human view — noise for a peek
  }
  process.stdout.write(lines.join('\n') + '\n')
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
  if (!prompt) exitWithError('USAGE', 'Usage: con agent create <prompt> [--cwd <path>] [--name <title>] [--project <slug>] [--areas <a,b>] [--wait]', flags)
  const opts = parseFlags(args.slice(1))

  // Get existing session IDs so we can distinguish replayed session_created from new ones
  const health = await hubFetch<{ sessions: Array<{ id: string }> }>('/health')
  const existingIds = new Set((health.sessions || []).map((s) => s.id))

  const { sendAndReceive, connectAndStream } = await import('../ws-client.js')

  // --name mints a stable agentKey (asAgent) and --project/--areas bind the
  // session into Spaces — the CLI path to a durable, space-visible agent
  // (e.g. the vault Curator: --name Curator --cwd ~/sync/brain --areas all).
  const areas = opts.areas ? opts.areas.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  // A space-bound create without --cwd lets the hub pick the space's home
  // (vault project dir / vault root); an unbound one runs where you stand.
  const cwd = opts.cwd || (opts.project || areas?.length ? undefined : process.cwd())

  // Create session — only match session_created with a NEW ID (not replayed)
  const result = await sendAndReceive(
    {
      type: 'create_session', prompt, ...(cwd ? { cwd } : {}),
      ...(opts.name ? { name: opts.name, asAgent: true } : {}),
      ...(opts.project ? { project: opts.project } : {}),
      ...(areas?.length ? { areas } : {}),
    },
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
  const opts = parseFlags(args)
  const target = args.filter((a) => !a.startsWith('--'))[0]
  if (!target) exitWithError('USAGE', 'Usage: con agent reload <session-id|name|agentKey|AL> [--from-csid <claudeSessionId>]', flags)
  const { sendAndReceive } = await import('../ws-client.js')

  if (target.toLowerCase() === 'al') {
    await sendAndReceive({ type: 'reload_al' }, () => false)
    output({ reloaded: 'AL', mode: 'fresh-persona-spawn' }, flags)
    return
  }

  // Resolve a live session by id, unique name, or agentKey, then respawn it.
  // MUST fail loudly on no match: the hub replies hub_error to an unknown id,
  // and printing success on top of that once broke a whole-fleet reload (the
  // sessions that "reloaded" by role key never actually respawned).
  let sessionId = target
  try {
    const health = await hubFetch<{ sessions: HealthSession[] }>('/health')
    const live = (health.sessions || []).filter((s) => s.status !== 'ended')
    if (!live.some((s) => s.id === target)) {
      const named = live.filter((s) => (s.name || '').toLowerCase() === target.toLowerCase())
      const keyed = live.filter((s) => s.agentKey === target)
      const matches = named.length ? named : keyed
      if (matches.length === 1) sessionId = matches[0]!.id
      else if (matches.length > 1) exitWithError('AMBIGUOUS', `Multiple sessions match "${target}" — use the id.`, flags)
      else exitWithError('NOT_FOUND', `No live session with id, name, or agentKey "${target}".`, flags)
    }
  } catch { /* /health unavailable — treat target as a raw id (exitWithError never throws; it exits) */ }

  await sendAndReceive({ type: 'reload_session', sessionId, ...(opts['from-csid'] ? { fromCsid: opts['from-csid'] } : {}) }, () => false)
  output({ reloaded: sessionId, ...(opts['from-csid'] ? { fromCsid: opts['from-csid'] } : {}) }, flags)
}

interface ModelState { model: string; chain: string[]; lockedByEnv: boolean }
interface BackendState { backend: string; presets: Array<{ id: string; label: string }> }

/** `con agent backend [get | set <first_party|bedrock>]` — switch which auth
 *  backend the whole fleet spawns under. Distinct from `con agent model`: this
 *  also rewrites ~/.claude/settings.json's env (each `claude` subprocess reads
 *  its backend from there at its OWN startup) and swaps the model chain to
 *  that backend's verified id format, then forces every live session to
 *  respawn (the in-place model-switch fast path can't apply a new backend to
 *  an already-running process). Use this when Max-subscription session limits
 *  are hit (switch to bedrock) or once they reset (switch back). */
async function agentBackend(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'get' || sub === 'list') {
    const state = await hubFetch<BackendState>('/agents/backend')
    output(state, flags)
    return
  }
  if (sub === 'set') {
    const backend = args[1]
    if (backend !== 'first_party' && backend !== 'bedrock') {
      exitWithError('USAGE', 'Usage: con agent backend set <first_party|bedrock>', flags)
      return
    }
    const state = await hubFetch<{ backend: string; label: string; chain: string[] }>('/agents/backend', { method: 'POST', body: { backend } })
    output(state, flags)
    return
  }
  exitWithError('USAGE', `Unknown: con agent backend ${sub}. Usage: con agent backend [get | set <first_party|bedrock>]`, flags)
}

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

/** `con agent merge <session-id|conv-id|name>` — fold a fork back into its parent:
 *  the fork self-summarises, the digest is injected into the parent, then the
 *  fork is closed. Parent = fork lineage (parentClaudeSessionId). */
async function agentMerge(args: string[], flags: GlobalFlags): Promise<void> {
  const idArg = args[0]
  if (!idArg) { exitWithError('USAGE', 'Usage: con agent merge <session-id|conv-id|name>', flags); return }
  let hubId = idArg
  if (!/^session_/.test(hubId)) {
    try { hubId = (await resolveByClaudeId(idArg)).id } catch { try { hubId = (await resolveByName(idArg)).id } catch { /* assume it's already a hub id */ } }
  }
  await runMerge(hubId, flags)
}

/** Shared merge runner — waits for the child's summary turn. The hub's capture
 *  window is inactivity-based (busy sessions extend it, hard ceiling 10min), so
 *  wait a bit past that ceiling. */
async function runMerge(hubId: string, flags: GlobalFlags): Promise<void> {
  const { sendAndReceive } = await import('../ws-client.js')
  const res = await sendAndReceive(
    { type: 'merge_session', sessionId: hubId },
    (m: any) => (m.type === 'session_merged' && m.forkId === hubId) || m.type === 'hub_error',
    11 * 60_000,
  )
  if (res.type === 'hub_error') { exitWithError('ERROR', res.message, flags); return }
  output({ merged: res.forkId, parentId: res.parentId, summary: res.summary }, flags)
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
