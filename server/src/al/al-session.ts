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

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
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
    console.log(`[al/session] recorded claudeSessionId ${existing.claudeSessionId} not in manifest — spawning fresh`)
  }

  const systemPrompt = await buildAlSystemPrompt()
  // Al's working directory IS his persona/workflow vault. This makes
  // `Read users/<name>.md`, `Read workflows/<slug>.md`, etc. resolve as
  // relative paths the way the prompt and the agent both expect.
  const session = createSession(ctx, {
    prompt: 'Booted by Console hub. Stay idle; respond when channels (WhatsApp, voice, console) bring you a message. Acknowledge briefly that you are online.',
    cwd: WORKSPACE_DIR,
    name: 'Al',
    systemPrompt,
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
