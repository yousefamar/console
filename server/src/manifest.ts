// Session manifest — persists active sessions across server restarts

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from './session.js'
import type { AttentionState } from './protocol.js'
import type { Effort, SpawnKind } from './agents/effort.js'

const MANIFEST_PATH = join(homedir(), '.claude', 'console-hub-sessions.json')
const TMP_PATH = MANIFEST_PATH + '.tmp'

export interface ManifestEntry {
  claudeSessionId: string
  cwd: string
  prompt: string
  name?: string
  /** Hub session id at save time. Hub ids are minted per process, so after a
   *  restart this becomes one of the successor's `formerHubIds` — how a stale
   *  `con agent send session_…` gets a "resumed as …" hint instead of a void. */
  hubId?: string
  /** Hub ids this conversation had in earlier hub processes, newest first. */
  formerHubIds?: string[]
  /** claudeSessionId of the parent session (forks) — restores sidebar nesting. */
  parentClaudeSessionId?: string
  /** Ticket-fork context mode (fresh | inherited) — see SessionOptions.forkContext. */
  forkContext?: 'fresh' | 'inherited'
  /** Stable slug for board `@key` addressing + CONSOLE_AGENT_KEY actor attribution. */
  agentKey?: string
  /** Vault project slug this session is bound to (Spaces agent panel). */
  project?: string
  /** PARA area tags this session is bound to. */
  areas?: string[]
  /** True if the session had an UNFINISHED turn when the manifest was last
   *  saved — the restore loop resumes these live and sends the "hub was
   *  restarted … Continue." nudge (everything else restores hibernated and
   *  silent). Derived from `Session.midTurn`, not from `status`: see below. */
  wasRunning?: boolean
  /** True if the USER explicitly ended this session (kill/delete). Restore
   *  skips + prunes these — an explicit "End session" must survive restarts.
   *  Absent for incidental subprocess deaths, which DO get resumed. */
  ended?: boolean
  /** Sticky `@amar` attention marker — survives hub restart. */
  needsAttention?: AttentionState | null
  /** Absolute message-log high-water — restored into the session's `logOffset`
   *  so the unread marker (messageLogLength > lastReadIndex) survives restart. */
  messageLogLength?: number
  /** Per-session model pin — survives restart so a pinned session resumes on
   *  its own model, not the hub-wide one. */
  modelOverride?: string
  /** Lifetime prompt-cache TTL pin (ticket forks = '1h') — survives a restart
   *  so the fork keeps its hour cache across the resume. */
  cacheTtl?: '5m' | '1h'
  /** Spawn kind + lifetime `--effort` pin (agents/effort.ts) — a restored fork
   *  must keep running at its kind's effort, not the generals' default. */
  spawnKind?: SpawnKind
  effort?: Effort
  /** Where the session's `claude` runs (server/src/forge/). A remote session's
   *  transcript and worktree live ON FORGE, so a restart has to resume it
   *  there or it would resume into an empty history. The restore path re-checks
   *  the box and downgrades to local if it is gone. */
  placement?: 'local' | 'forge'
  /** Its forwarded dev-server port, so the forward is re-established with the
   *  same number the card already advertises. */
  devPort?: number
  /** A prompt queued for turn-end that hadn't flushed yet. Surviving a restart
   *  mid-turn is the reason the queue lives hub-side at all. */
  queuedMessage?: string
  /** Hub text owed to the agent with its next message (Session.nextMessageNote). */
  nextMessageNote?: string
}

/** Write the manifest synchronously and atomically.
 *
 *  Every call hits disk — there is no in-memory buffering or debounce.
 *  An SIGKILL'd hub still leaves a complete, up-to-date manifest behind.
 *  Atomic via write-to-tmp + rename so a crash mid-write can't corrupt the file.
 *
 *  We persist EVERY session with a claudeSessionId, including `ended` ones,
 *  so a subprocess dying (SDK timeout, host hibernate, etc.) doesn't silently
 *  delete the session from the user's sidebar — those get `--resume`'d on
 *  restart. Sessions the USER explicitly ended carry `ended: true` and are
 *  skipped + pruned by the restore loop instead of resurrected. Removal is
 *  driven by `delete_session` (or `ended` pruning), never by subprocess
 *  lifecycle alone.
 */
export function saveManifest(sessions: Map<string, Session>) {
  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const session of sessions.values()) {
    if (!session.claudeSessionId || seen.has(session.claudeSessionId)) continue
    seen.add(session.claudeSessionId)
    entries.push({
      claudeSessionId: session.claudeSessionId,
      cwd: session.cwd,
      prompt: session.initialPrompt,
      name: session.name,
      hubId: session.id,
      ...(session.formerIds.length ? { formerHubIds: session.formerIds } : {}),
      ...(session.parentClaudeSessionId ? { parentClaudeSessionId: session.parentClaudeSessionId } : {}),
      ...(session.forkContext ? { forkContext: session.forkContext } : {}),
      ...(session.agentKey ? { agentKey: session.agentKey } : {}),
      ...(session.project ? { project: session.project } : {}),
      ...(session.areas?.length ? { areas: session.areas } : {}),
      // `midTurn` is the durable half: pm2's treekill SIGINTs the claude
      // children too, so they can exit (→ status 'ended') before the hub saves
      // this file, which is how mid-turn sessions came back with no restart
      // nudge. See Session.midTurn.
      wasRunning: session.status === 'running' || session.midTurn,
      ...(session.endedByUser ? { ended: true } : {}),
      ...(session.needsAttention ? { needsAttention: session.needsAttention } : {}),
      ...(session.messageLogLength > 0 ? { messageLogLength: session.messageLogLength } : {}),
      ...(session.modelOverride ? { modelOverride: session.modelOverride } : {}),
      ...(session.cacheTtlPin ? { cacheTtl: session.cacheTtlPin } : {}),
      ...(session.spawnKind !== 'default' ? { spawnKind: session.spawnKind } : {}),
      ...(session.effortPin ? { effort: session.effortPin } : {}),
      ...(session.placement === 'forge' ? { placement: session.placement } : {}),
      ...(session.devPort ? { devPort: session.devPort } : {}),
      ...(session.queuedMessage ? { queuedMessage: session.queuedMessage } : {}),
      ...(session.nextMessageNote ? { nextMessageNote: session.nextMessageNote } : {}),
    })
  }
  try {
    writeFileSync(TMP_PATH, JSON.stringify(entries, null, 2))
    renameSync(TMP_PATH, MANIFEST_PATH)
  } catch {
    // Best effort
  }
}

/** Kept for callsite compatibility — manifest is always written synchronously now. */
export const saveManifestSync = saveManifest

/** A claudeSessionId is a UUID. The 8-char ids `con agent search/read` print are
 *  display prefixes and `session_N_…` is a hub id; `claude --resume` accepts
 *  neither, so an entry keyed by one can never init. */
export const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return []
  try {
    const data = readFileSync(MANIFEST_PATH, 'utf-8')
    const entries = JSON.parse(data) as ManifestEntry[]
    // Drop unresumable rows rather than spawning a child per boot that exits 1
    // before init. Left in, they read to the fallback chain as "this model is
    // unavailable" — on 6 Oct 2026 six of them walked all seven Bedrock entries
    // in 70 s and parked the fleet on haiku. They are never re-saved, since
    // saveManifest writes from live sessions, so this self-heals.
    const good = entries.filter((e) => CLAUDE_SESSION_ID_RE.test(e?.claudeSessionId ?? ''))
    if (good.length !== entries.length) {
      const bad = entries.filter((e) => !CLAUDE_SESSION_ID_RE.test(e?.claudeSessionId ?? '')).map((e) => e?.claudeSessionId)
      console.log(`[manifest] dropped ${entries.length - good.length} unresumable entr${entries.length - good.length === 1 ? 'y' : 'ies'} (not a claudeSessionId UUID): ${bad.join(', ')}`)
    }
    return good
  } catch {
    return []
  }
}
