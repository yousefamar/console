// Al Console session bootstrap.
//
// Al is a permanent Console-managed Claude session, spawned at hub boot with
// AL.md + mistakes.md + workflows summary as its system prompt. The session
// is restored from the manifest on subsequent boots, the same as every other
// Console session — we only spawn fresh if no prior session exists OR the
// recorded claudeSessionId is no longer in the manifest.
//
// Inbound messages from any channel (WhatsApp, voice, future SMS/email) are
// injected via `Session.sendMessage(envelope)`. Al's Claude context IS the
// routing state — no per-thread session table.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Session } from '../session.js'
import { createSession, type AgentContext } from '../routes/agents.js'
import { AL_SESSION_FILE, WORKSPACE_DIR } from './identity.js'
import { buildAlSystemPrompt } from './persona.js'

interface AlSessionFile {
  version: 1
  claudeSessionId: string
  hubSessionId: string
  createdAt: number
}

function loadAlSession(): AlSessionFile | null {
  try {
    if (!existsSync(AL_SESSION_FILE)) return null
    const parsed = JSON.parse(readFileSync(AL_SESSION_FILE, 'utf-8')) as Partial<AlSessionFile>
    if (parsed.version !== 1 || !parsed.claudeSessionId) return null
    return parsed as AlSessionFile
  } catch {
    return null
  }
}

function saveAlSession(file: AlSessionFile): void {
  try {
    mkdirSync(dirname(AL_SESSION_FILE), { recursive: true })
    writeFileSync(AL_SESSION_FILE, JSON.stringify(file, null, 2), 'utf-8')
    try { chmodSync(AL_SESSION_FILE, 0o600) } catch { /* non-unix */ }
  } catch (err) {
    console.error('[al/session] save failed:', (err as Error)?.message)
  }
}

let currentAlSession: Session | null = null

/** Return the live Al session, or null if not bootstrapped yet. */
export function getAlSession(): Session | null {
  return currentAlSession
}

/** claudeSessionId recorded as the official Al (from al-session.json), or null.
 *  The manifest-restore loop uses this to re-instantiate ONLY the official Al
 *  and skip stale Al duplicates, so a second "Al" never appears on boot. */
export function getRecordedAlSessionId(): string | null {
  return loadAlSession()?.claudeSessionId ?? null
}

/**
 * Bootstrap the Al session. Idempotent: if Al already exists in
 * `ctx.sessions` (restored from manifest), we just record it; otherwise we
 * spawn a fresh one with the persona system prompt and persist the
 * claudeSessionId once Claude emits it.
 */
export async function ensureAlSession(ctx: AgentContext): Promise<Session> {
  const existing = loadAlSession()
  if (existing) {
    for (const s of ctx.sessions.values()) {
      if (s.claudeSessionId === existing.claudeSessionId) {
        currentAlSession = s
        console.log(`[al/session] resumed Al (claude=${existing.claudeSessionId.slice(0, 8)} hub=${s.id})`)
        return s
      }
    }
    console.log(`[al/session] recorded claudeSessionId ${existing.claudeSessionId} not in manifest`)
  }

  // The recorded session isn't live (stale al-session.json after reloads/
  // restarts). Before spawning a fresh Al — which would appear as a DUPLICATE
  // alongside any Al the manifest already restored (the orphan-Al footgun) —
  // adopt an existing Al session if one exists and re-point al-session.json to
  // it. Only spawn fresh when there is genuinely no Al. With the manifest-
  // restore dedup (index.ts), this guarantees exactly one Al per boot, with no
  // session ever being killed.
  for (const s of ctx.sessions.values()) {
    if ((s.agentKey === 'al' || s.name === 'Al') && s.status !== 'ended' && s.claudeSessionId) {
      currentAlSession = s
      saveAlSession({ version: 1, claudeSessionId: s.claudeSessionId, hubSessionId: s.id, createdAt: Date.now() })
      console.log(`[al/session] adopted existing Al ${s.id} (claude=${s.claudeSessionId.slice(0, 8)}) — re-pointed al-session.json`)
      return s
    }
  }

  console.log('[al/session] no existing Al — spawning fresh')
  const systemPrompt = await buildAlSystemPrompt()
  // Al is the org-chart root. Ensure his role node exists (idempotent — the
  // backfill usually already created it). Its charter is NEVER injected — Al
  // passes his own richer buildAlSystemPrompt, and createSession's
  // `!options.systemPrompt` guard respects that. The role file is purely Al's
  // org-chart node + the default manager target for top-level agents.
  if (!ctx.agentRegistry.has('al')) {
    ctx.agentRegistry.create('al', { title: 'Al', charter: 'Al — personal AI orchestrator and org-chart root. (Persona lives in AL.md; this file is just Al’s org node.)' })
  }
  // Al's working directory IS his persona/workflow vault. This makes
  // `Read users/<name>.md`, `Read workflows/<slug>.md`, etc. resolve as
  // relative paths the way the prompt and the agent both expect.
  const session = createSession(ctx, {
    prompt: [
      'Booted by Console hub. Stay idle; channels (WhatsApp, voice, console) will inject envelope-prefixed messages.',
      '',
      'Quick reminder for when WhatsApp envelopes arrive:',
      '  - The reply path is Bash → `con whatsapp send <jid> --body "<short conversational reply>"`.',
      '  - Your in-session text is the operator log, NOT the reply the sender sees.',
      '  - Example: envelope says `Thread: 447700900123@s.whatsapp.net` and `Message: Hey what time?`.',
      '    First action: Bash `con whatsapp send 447700900123@s.whatsapp.net --body "3pm, see you then"`.',
      '    Then in this session: one line — "replied: 3pm see you then".',
      '',
      'Acknowledge briefly that you are online.',
    ].join('\n'),
    cwd: WORKSPACE_DIR,
    name: 'Al',
    systemPrompt,
    agentKey: 'al',
  })
  currentAlSession = session

  // Capture the claudeSessionId once Claude emits it (session_init), persist
  // so subsequent boots resume the same Claude conversation.
  const onInit = (msg: { type: string; claudeSessionId?: string }) => {
    if (msg.type === 'session_init' && msg.claudeSessionId) {
      session.off('hub_message', onInit as any)
      saveAlSession({
        version: 1,
        claudeSessionId: msg.claudeSessionId,
        hubSessionId: session.id,
        createdAt: Date.now(),
      })
      console.log(`[al/session] persisted Al claudeSessionId=${msg.claudeSessionId.slice(0, 8)}`)
    }
  }
  session.on('hub_message', onInit as any)

  return session
}

/**
 * Force a fresh Al spawn so persona edits (`AL.md` / `persona.ts`) take effect
 * WITHOUT a hub restart. Tears down the current Al session + the recorded
 * `al-session.json`, then re-runs `ensureAlSession` (which fresh-spawns, since
 * no record remains → new `claudeSessionId`, persona re-derived). Works whether
 * Al is currently up or already down. This is what `con agent reload Al` calls.
 *
 * A plain `Session.reload()` would only *resume* Al, keeping his stale baked-in
 * `--append-system-prompt` — that's why Al needs this dedicated path.
 */
export async function reloadAlSession(ctx: AgentContext): Promise<Session> {
  const existing = currentAlSession
  if (existing) {
    try { existing.kill() } catch { /* ignore */ }
    ctx.sessions.delete(existing.id)
  }
  currentAlSession = null
  try { if (existsSync(AL_SESSION_FILE)) unlinkSync(AL_SESSION_FILE) } catch { /* ignore */ }
  console.log('[al/session] reloading Al — fresh persona spawn')
  return ensureAlSession(ctx)
}

/**
 * Inject a system-event envelope into Al's session as a user_prompt and
 * broadcast it so the SPA renders it in Al's chat. Used by WhatsApp QR self-
 * heal, voice events, etc. Returns false if Al isn't up yet.
 */
export function injectToAl(envelope: string, broadcast: (msg: any) => void): boolean {
  const session = currentAlSession
  if (!session) return false
  const promptMsg = { type: 'user_prompt' as const, sessionId: session.id, content: envelope }
  try {
    broadcast(promptMsg)
    session.logMessage(promptMsg)
    session.sendMessage(envelope)
    return true
  } catch (err) {
    console.error('[al/session] inject failed:', (err as Error)?.message)
    return false
  }
}
