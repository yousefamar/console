// Per-conversation forks of Al ("conversation forks").
//
// When a NON-OWNER WhatsApp message arrives, Al forks himself for that thread
// and all subsequent messages from the same thread JID route to the fork.
// The parent Al never sees the raw conversation — only (eventually) a digest.
// Why: (1) privacy — concurrent conversations (e.g. Mai + Nica) never share a
// context window, making per-contact deny-walls a physical boundary rather
// than an instruction; (2) the parent's context stays clean instead of
// accreting every group-chat ping.
//
// Owner (Yousef) messages NEVER fork — they go to the parent directly. He IS
// the main relationship; routing him via a fork that merges hourly would give
// parent-Al a delayed, second-hand view of its own owner.
//
// Idle lifecycle (checked once a minute). "Idle" is measured from whichever is
// later: the last inbound message, or the end of the fork's last turn.
//   - DEFAULT: digest-merge into the parent (mergeIntoParent — same path as
//     `con agent merge`). What a fork learned or did must reach the parent.
//   - a PROVABLY trivial conversation → reap silently (kill + remove from the
//     list; the full transcript stays on disk + in the Beeper chat archive). A
//     digest of "he said thanks, I said np" is worth less than the 2 turns it
//     costs. Provably = the hub watched every tool call of the fork's life
//     (`observed`), every one was a plain reply to its own thread, and there
//     were ≤ TRIVIAL_MAX inbound messages.
//
// Why it is that way round (9 Oct 2026): the "any tool call beyond the
// reply-send makes it substantive" half was never wired — `markSubstantive`
// had no caller — so message count alone decided. A fork that spent 95 minutes
// and 245 tool calls on one request (it got Yousef's approval, wrote 17 files,
// published a canvas tab and sent the result) had 2 inbound messages, was
// called "trivial (2 msg)" and removed with no merge, 15 minutes after it
// finished, because the clock ran from her last message rather than its own
// last work. Yousef: "It should have folded back into the parent at least, we
// can't lose fork information like this." Nothing was lost only because that
// fork had written its own notes to disk.
//
// Introspection: forks are ordinary hub sessions — they show in
// `con agent list` (nested under Al), and `con agent peek <id|name>` gives a
// READ-ONLY transcript view. Al's persona tells him to audit his active forks.
//
// Routing table is persisted (al-conversation-forks.json) so a hub restart
// mid-conversation keeps routing to the (restored) fork rather than silently
// splitting the conversation between fork and parent.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Session } from '../session.js'
import type { AgentContext } from '../routes/agents.js'
import { createSession, wakeSession, mergeIntoParent, mintAgentKey } from '../routes/agents.js'
import { saveManifest } from '../manifest.js'
import { getAlSession } from './al-session.js'
import { AL_NAME } from './identity.js'
import { identifiersFor, normalize, resolveUsername } from './users.js'

// Resolved per call (not captured at module load) so tests can point it at a
// tmp dir via CONSOLE_AL_FORKS_FILE — the todo-store tasksRoot() precedent.
function forksFile(): string {
  return process.env.CONSOLE_AL_FORKS_FILE || join(homedir(), '.config', 'console', 'al-conversation-forks.json')
}

/** Idle time before a fork is wound down. */
const IDLE_MS = 60 * 60 * 1000
/** ≤ this many inbound messages AND no extra tool work ⇒ trivial ⇒ reap, no merge. */
const TRIVIAL_MAX_INBOUND = 2
/** Sweep cadence. */
const SWEEP_MS = 60 * 1000

export interface ForkRecord {
  threadJid: string
  /** Who the fork is talking to (resolved user / push name) — names the fork
   *  in the owner envelope's "Active conversation forks" line. */
  label?: string
  hubSessionId: string
  claudeSessionId?: string
  createdAt: number
  lastInboundAt: number
  inboundCount: number
  /** True once the fork did anything beyond replying (see `workCalls`). */
  substantive?: boolean
  /** Tool calls that were NOT a plain reply to this thread — the evidence. */
  workCalls?: number
  /** The hub has watched every tool call since this fork was born. Records
   *  from before that existed lack it, and an unwatched history is never
   *  "trivial": it gets merged. */
  observed?: boolean
  /** When the fork last finished a turn. Its own work keeps it alive, not
   *  only the other person's messages. */
  lastTurnEndAt?: number
  /** Every identifier of the person on this thread, normalised — a send to
   *  any of them is the reply; a send to anyone else is work. */
  ids?: string[]
}

/** When the conversation last moved: their last message or the fork's last
 *  finished turn, whichever is later. */
export function lastMovedAt(rec: ForkRecord): number {
  return Math.max(rec.lastInboundAt, rec.lastTurnEndAt ?? 0)
}

/** Is this tool call nothing more than the fork replying to its own thread?
 *
 *  Only a bare `con whatsapp send <one of this thread's ids> …` counts. A send
 *  to anyone else (the fork asking Yousef for approval, say), a different verb
 *  (`send-file`), or a send chained to other commands is work. Shell
 *  metacharacters are looked for OUTSIDE quotes, since the message body may
 *  legitimately contain them. When in doubt it is work: the cost of a needless
 *  merge is two turns, the cost of a wrong reap is everything the fork knew. */
export function isReplySend(toolName: string, input: Record<string, unknown>, threadIds: string[]): boolean {
  if (toolName !== 'Bash') return false
  const command = String(input.command ?? '').trim()
  const m = /^con\s+whatsapp\s+send\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/.exec(command)
  if (!m) return false
  const target = normalize(m[1] ?? m[2] ?? m[3] ?? '')
  if (!target || !threadIds.map(normalize).includes(target)) return false
  return !runsMoreThanOneCommand(command)
}

/** Does this shell line do more than run one command? Walks the string the way
 *  a shell would: `; & | newline` outside quotes chain commands, and a command
 *  substitution runs one even inside double quotes. Single quotes are inert. */
function runsMoreThanOneCommand(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") { if (c === "'") quote = null; continue }
    if (c === '\\') { i++; continue }
    if (c === '`' || (c === '$' && command[i + 1] === '(')) return true
    if (quote === '"') { if (c === '"') quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === ';' || c === '&' || c === '|' || c === '\n') return true
  }
  return false
}

interface ForksFile {
  version: 1
  forks: Record<string, ForkRecord> // keyed by threadJid
}

function loadForks(): ForksFile {
  try {
    if (!existsSync(forksFile())) return { version: 1, forks: {} }
    const parsed = JSON.parse(readFileSync(forksFile(), 'utf-8')) as ForksFile
    if (parsed.version !== 1) return { version: 1, forks: {} }
    return parsed
  } catch {
    return { version: 1, forks: {} }
  }
}

function saveForks(f: ForksFile): void {
  try {
    const tmp = forksFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(f, null, 2))
    renameSync(tmp, forksFile())
  } catch (err) {
    console.error('[al/forks] save failed:', (err as Error)?.message)
  }
}

let state: ForksFile = { version: 1, forks: {} }
let sweepTimer: ReturnType<typeof setInterval> | null = null
/** Threads with a fork mid-spawn — inbound during the gap queues here. */
const pendingSpawns = new Map<string, string[]>()

/** Resolve a fork record to its live session, dropping stale records. */
function liveFork(ctx: AgentContext, rec: ForkRecord): Session | null {
  const byHubId = ctx.sessions.get(rec.hubSessionId)
  if (byHubId && byHubId.status !== 'ended') return byHubId
  if (rec.claudeSessionId) {
    for (const s of ctx.sessions.values()) {
      if (s.claudeSessionId === rec.claudeSessionId && s.status !== 'ended') {
        rec.hubSessionId = s.id // re-point after a hub restart re-minted hub ids
        return s
      }
    }
  }
  return null
}

/** Exported for tests. `otherIds` = the contact's OTHER identifiers (phone vs
 *  @lid) — without naming them the fork reads Al's recent sends to the other
 *  JID as a different conversation and answers a stale antecedent. */
export function forkSeed(threadJid: string, senderLabel: string, otherIds: string[] = []): string {
  return [
    `[CONVERSATION FORK] You are a fork of AL dedicated to ONE WhatsApp conversation: ${senderLabel} (thread ${threadJid}).`,
    ...(otherIds.length ? [
      `This is the SAME PERSON as ${otherIds.join(', ')} — one conversation across all their identities; anything you (Al) recently sent to any of them is part of this thread.`,
    ] : []),
    `All messages from this thread now come to you, not your parent. Handle them exactly per your persona — identity rules, allow/deny walls, reply via \`con whatsapp send ${threadJid} --body "..."\`.`,
    `You know everything parent-AL knew up to this branch point, but you are ONLY this conversation's handler — do not act on other threads.`,
    `When the conversation goes quiet you will be wound down automatically (merged back or closed). No action needed from you.`,
  ].join('\n')
}

/**
 * Route an inbound envelope: owner + non-WhatsApp-threadable input → parent
 * (returns false = caller should injectToAl as before). Non-owner thread →
 * ensure/reuse a fork and wake it with the envelope (returns true = handled).
 */
export function routeInbound(
  ctx: AgentContext,
  threadJid: string,
  resolvedUser: string | null,
  senderLabel: string,
  envelope: string,
  /** Non-WhatsApp threads (the ring's fallback fork) supply their own seed —
   *  the default one frames the fork as a WhatsApp conversation. */
  opts: { seed?: string } = {},
): boolean {
  // Owner thread → parent, always.
  if (resolvedUser === 'yousef') return false
  const parent = getAlSession()
  if (!parent?.claudeSessionId) return false // Al not ready — fall back to parent path

  // Message arrived while this thread's fork is still spawning → queue it.
  const queued = pendingSpawns.get(threadJid)
  if (queued) { queued.push(envelope); return true }

  const rec = state.forks[threadJid]
  if (rec) {
    const fork = liveFork(ctx, rec)
    if (fork) {
      rec.lastInboundAt = Date.now()
      rec.inboundCount++
      saveForks(state)
      wakeSession(ctx, fork, envelope)
      return true
    }
    delete state.forks[threadJid] // stale — fork gone (reaped/merged/lost)
  }

  // New conversation → fork Al.
  pendingSpawns.set(threadJid, [])
  try {
    const fork = createSession(ctx, {
      prompt: '',
      cwd: parent.cwd,
      resume: parent.claudeSessionId,
      fork: true,
      silent: true,
      name: `${AL_NAME} ↔ ${senderLabel}`,
      // Rides into the fork's env as CONSOLE_AGENT_KEY, so its `con whatsapp
      // send` calls carry X-Console-Agent and the thread history can say
      // "AL(nica fork)→Yousef" rather than crediting the parent.
      agentKey: mintAgentKey(ctx, `al ${senderLabel}`),
      parentClaudeSessionId: parent.claudeSessionId,
      // Inherit Al's space binding (fork_session does the same) — without it
      // the fork has no project/areas and the Spaces rail buries it in
      // ~unassigned instead of showing it beside Al ("I don't see any forks").
      project: parent.project,
      areas: parent.areas,
    })
    const otherIds = identifiersFor(resolvedUser).filter((id) => id !== normalize(threadJid))
    state.forks[threadJid] = {
      threadJid,
      label: senderLabel,
      hubSessionId: fork.id,
      createdAt: Date.now(),
      lastInboundAt: Date.now(),
      inboundCount: 1,
      observed: true,
      workCalls: 0,
      ids: [normalize(threadJid), ...otherIds],
    }
    // Watch BEFORE the first wake, so not one tool call of its life is missed.
    watchFork(fork, threadJid)
    // CRITICAL: a --fork-session emits no init until it gets input — send the
    // seed + envelope immediately (same rule as fork_session/con agent chat).
    wakeSession(ctx, fork, `${opts.seed ?? forkSeed(threadJid, senderLabel, otherIds)}\n\n${envelope}`)
    // Capture the fork's own claudeSessionId when it lands, then flush any
    // messages that arrived during the spawn gap.
    const onInit = (msg: { type: string; claudeSessionId?: string }) => {
      if (msg.type !== 'session_init' || !msg.claudeSessionId) return
      fork.off('hub_message', onInit as any)
      const rec2 = state.forks[threadJid]
      if (rec2) { rec2.claudeSessionId = msg.claudeSessionId; saveForks(state) }
      const backlog = pendingSpawns.get(threadJid) ?? []
      pendingSpawns.delete(threadJid)
      for (const env of backlog) {
        const r = state.forks[threadJid]
        if (r) { r.lastInboundAt = Date.now(); r.inboundCount++ }
        wakeSession(ctx, fork, env)
      }
      saveForks(state)
    }
    fork.on('hub_message', onInit as any)
    saveForks(state)
    console.log(`[al/forks] forked for ${threadJid} → ${fork.id}`)
    return true
  } catch (err) {
    console.error('[al/forks] fork spawn failed — falling back to parent:', (err as Error)?.message)
    const backlog = pendingSpawns.get(threadJid) ?? []
    pendingSpawns.delete(threadJid)
    delete state.forks[threadJid]
    // Signal unhandled so the caller injects into the parent (plus flush any
    // queued backlog there too — better duplicated-to-parent than dropped).
    for (const env of backlog) {
      const p = getAlSession()
      if (p) wakeSession(ctx, p, env)
    }
    return false
  }
}

/** Follow a fork's own stream: count the tool calls that are not a plain reply,
 *  and note when each turn ends. This is the evidence windDown decides on. It
 *  replaces `markSubstantive`, which existed for the same purpose and was never
 *  called by anything. */
function watchFork(fork: Session, threadJid: string): void {
  const onMessage = (msg: { type: string; toolName?: string; input?: Record<string, unknown> }) => {
    const rec = state.forks[threadJid]
    // The record may have moved on (wound down, or re-forked for a new session).
    if (!rec) return
    const sameSession = rec.hubSessionId === fork.id || (!!rec.claudeSessionId && rec.claudeSessionId === fork.claudeSessionId)
    if (!sameSession) return
    if (msg.type === 'tool_use') {
      if (isReplySend(msg.toolName ?? '', msg.input ?? {}, rec.ids ?? [threadJid])) return
      rec.workCalls = (rec.workCalls ?? 0) + 1
      // Persist the transition, not every call: a long turn makes hundreds.
      if (!rec.substantive) { rec.substantive = true; saveForks(state) }
    } else if (msg.type === 'result') {
      rec.lastTurnEndAt = Date.now()
      saveForks(state)
    }
  }
  fork.on('hub_message', onMessage as never)
}

/** Why this fork's conversation goes to the parent — or null when it is
 *  PROVABLY trivial and may be dropped. Merging is the default; every clause
 *  here is a reason, and the absence of proof is one of them. Pure. */
export function mergeReason(rec: ForkRecord): string | null {
  if (!rec.observed) return 'its history was not watched'
  if (rec.substantive || (rec.workCalls ?? 0) > 0) return `${rec.workCalls ?? 'some'} tool call(s) beyond replying`
  if (rec.inboundCount > TRIVIAL_MAX_INBOUND) return `${rec.inboundCount} inbound messages`
  return null
}

async function windDown(ctx: AgentContext, rec: ForkRecord): Promise<void> {
  const fork = liveFork(ctx, rec)
  delete state.forks[rec.threadJid]
  saveForks(state)
  if (!fork) return
  if (fork.status === 'running') {
    // Mid-turn — push the deadline instead of interrupting real work.
    state.forks[rec.threadJid] = { ...rec, lastInboundAt: Date.now() }
    saveForks(state)
    return
  }
  // A pending @amar marker means the fork asked Yousef something that hasn't
  // been acknowledged — NEVER reap it (the Rowan fork was reaped as "trivial"
  // while carrying an unanswered Bedrock-key request; the marker died with
  // it). Leave it alive + routed; it stays visible until Yousef responds.
  if (fork.needsAttention) {
    state.forks[rec.threadJid] = { ...rec, lastInboundAt: Date.now() }
    saveForks(state)
    console.log(`[al/forks] idle ${rec.threadJid} — has a pending @amar marker, keeping alive`)
    return
  }
  // Wound-down forks GO AWAY (Yousef's call — keeping them listed clogs the
  // rail). The list shows live conversations only; history lives in the
  // transcripts on disk + the chat archive, and anything important reaches
  // the parent as a digest first. The @amar guard above is what prevents a
  // fork that's waiting on Yousef from being removed.
  const why = mergeReason(rec)
  if (why) {
    console.log(`[al/forks] idle ${rec.threadJid} — merging digest into parent (${why}), then removing`)
    const res = await mergeIntoParent(ctx, fork.id)
    if (!res.ok) {
      console.warn(`[al/forks] merge failed (${res.error}) — keeping alive (nothing lost)`)
      state.forks[rec.threadJid] = { ...rec, lastInboundAt: Date.now() }
      saveForks(state)
    }
  } else {
    // Provably trivial — not worth 2 turns of digest. Remove from the list
    // entirely (kill + delete + persist + broadcast, mirroring
    // mergeIntoParent); transcript survives on disk if forensics are ever needed.
    console.log(`[al/forks] idle ${rec.threadJid} — trivial (${rec.inboundCount} msg, every tool call a reply), removing without merge`)
    try { fork.kill() } catch { /* ignore */ }
    ctx.sessions.delete(fork.id)
    saveManifest(ctx.sessions)
    const list = JSON.stringify({ type: 'sessions_list', sessions: Array.from(ctx.sessions.values()).map((s) => s.getInfo()) })
    for (const ws of ctx.clients) { if (ws.readyState === 1) ws.send(list) }
  }
}

/** Start the router: load persisted routing table + begin the idle sweep. */
export function startConversationForks(ctx: AgentContext): void {
  // A restart can't have spawns in flight — clear the gap-queue (also resets
  // state between tests, which call this per-case).
  pendingSpawns.clear()
  state = loadForks()
  // Drop records whose sessions didn't survive the restart (liveFork also
  // re-points hub ids that the restore loop re-minted).
  for (const [jid, rec] of Object.entries(state.forks)) {
    const fork = liveFork(ctx, rec)
    if (!fork) { delete state.forks[jid]; continue }
    // The watcher lived on the old Session object. Nothing ran while the hub
    // was down, so re-attaching here leaves no gap in what was observed.
    watchFork(fork, jid)
  }
  saveForks(state)
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const rec of Object.values(state.forks)) {
      if (now - lastMovedAt(rec) > IDLE_MS) {
        windDown(ctx, rec).catch((err) => console.error('[al/forks] windDown failed:', (err as Error)?.message))
      }
    }
  }, SWEEP_MS)
  sweepTimer.unref()
  const n = Object.keys(state.forks).length
  console.log(`[al/forks] conversation-fork router started (${n} restored)`)
}

/** For tests + introspection endpoints. */
export function activeForks(): ForkRecord[] {
  return Object.values(state.forks)
}

/** Owner-envelope view: who each live fork is talking to + when it last
 *  heard from them. Records persisted before `label` existed fall back to
 *  the resolved user of the thread. */
export function forkSummaries(): Array<{ label: string; lastInboundAt: number }> {
  return Object.values(state.forks).map((r) => ({
    label: r.label ?? resolveUsername(r.threadJid) ?? r.threadJid,
    lastInboundAt: r.lastInboundAt,
  }))
}
