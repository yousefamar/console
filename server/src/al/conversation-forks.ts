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
// Idle lifecycle (checked once a minute):
//   - a fork idle > IDLE_MS with a SUBSTANTIVE conversation (> TRIVIAL_MAX
//     inbound messages or any tool call beyond the reply-send) → digest-merge
//     into the parent (mergeIntoParent — same path as `con agent merge`).
//   - a trivial conversation → reap silently (kill_session semantics; the
//     full transcript stays on disk + in the Beeper chat archive). A digest
//     of "he said thanks, I said np" is worth less than the 2 turns it costs.
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
import { createSession, wakeSession, mergeIntoParent } from '../routes/agents.js'
import { saveManifest } from '../manifest.js'
import { getAlSession } from './al-session.js'

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

interface ForkRecord {
  threadJid: string
  hubSessionId: string
  claudeSessionId?: string
  createdAt: number
  lastInboundAt: number
  inboundCount: number
  /** True once the fork did anything beyond replying (extra tool calls). */
  substantive?: boolean
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

function forkSeed(threadJid: string, senderLabel: string): string {
  return [
    `[CONVERSATION FORK] You are a fork of Al dedicated to ONE WhatsApp conversation: ${senderLabel} (thread ${threadJid}).`,
    `All messages from this thread now come to you, not your parent. Handle them exactly per your persona — identity rules, allow/deny walls, reply via \`con whatsapp send ${threadJid} --body "..."\`.`,
    `You know everything parent-Al knew up to this branch point, but you are ONLY this conversation's handler — do not act on other threads.`,
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
      name: `Al ↔ ${senderLabel}`,
      parentClaudeSessionId: parent.claudeSessionId,
      // Inherit Al's space binding (fork_session does the same) — without it
      // the fork has no project/areas and the Spaces rail buries it in
      // ~unassigned instead of showing it beside Al ("I don't see any forks").
      project: parent.project,
      areas: parent.areas,
    })
    state.forks[threadJid] = {
      threadJid,
      hubSessionId: fork.id,
      createdAt: Date.now(),
      lastInboundAt: Date.now(),
      inboundCount: 1,
    }
    // CRITICAL: a --fork-session emits no init until it gets input — send the
    // seed + envelope immediately (same rule as fork_session/con agent chat).
    wakeSession(ctx, fork, `${forkSeed(threadJid, senderLabel)}\n\n${envelope}`)
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

/** Mark a thread's fork as substantive (did real work beyond replying). */
export function markSubstantive(threadJid: string): void {
  const rec = state.forks[threadJid]
  if (rec && !rec.substantive) { rec.substantive = true; saveForks(state) }
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
  const substantive = rec.substantive || rec.inboundCount > TRIVIAL_MAX_INBOUND
  if (substantive) {
    console.log(`[al/forks] idle ${rec.threadJid} — merging digest into parent, then removing`)
    const res = await mergeIntoParent(ctx, fork.id)
    if (!res.ok) {
      console.warn(`[al/forks] merge failed (${res.error}) — keeping alive (nothing lost)`)
      state.forks[rec.threadJid] = { ...rec, lastInboundAt: Date.now() }
      saveForks(state)
    }
  } else {
    // Trivial — not worth 2 turns of digest. Remove from the list entirely
    // (kill + delete + persist + broadcast, mirroring mergeIntoParent);
    // transcript survives on disk if forensics are ever needed.
    console.log(`[al/forks] idle ${rec.threadJid} — trivial (${rec.inboundCount} msg), removing without merge`)
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
    if (!liveFork(ctx, rec)) delete state.forks[jid]
  }
  saveForks(state)
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const rec of Object.values(state.forks)) {
      if (now - rec.lastInboundAt > IDLE_MS) {
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
