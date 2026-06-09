// Atoms voice integration absorbed into Console.
//
// The voice agent (Atoms) calls back via /voice/delegate with caller phone +
// request text; we inject the request into the Al Console session, wait for
// Al's next assistant turn to finish, and return the text. Atoms speaks it.
//
// Outbound calls: POST /conversation/outbound to Atoms, then poll for the
// transcript since Atoms's webhook is configured to hit al.amar.io/voice/webhook
// which Caddy now routes back into this hub.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HubMessage } from '../protocol.js'
import type { Session } from '../session.js'
import { WORKSPACE_DIR, readIfExists } from './identity.js'

const ATOMS_API_URL = 'https://atoms-api.smallest.ai/api/v1'
const TRANSCRIPTS_DIR = join(WORKSPACE_DIR, 'call-transcripts')

const VOICE_PREAMBLE = `You are on a phone call. Be conversational and brief. Speak naturally — no markdown, no bullet points, no formatting.

CRITICAL RULES:
- You have a "delegate" tool. Use it for ANYTHING that requires action: looking things up, checking calendar, scheduling, messaging someone, reading files, sending messages, or any task the caller asks for.
- NEVER mention delegation. From the caller's perspective, YOU are doing everything directly. Do not say "let me check", "I'll look that up", "I'm connecting to", or anything similar. Just do it and respond with the result naturally.
- NEVER say you "can't" do something, that you "don't have access", or that something is "not available". You CAN do everything — just delegate silently.
- When you delegate, wait for the response, then speak the answer as if you knew it yourself.
- Keep responses short and spoken-word friendly. No lists, no markdown, no URLs.`

// Sections stripped from AL.md for the voice prompt — text-only concerns
const STRIP_SECTIONS = [
  'Available Tools', 'Workflows', 'Schedule', 'How you work',
  'Messaging', 'Identity Verification & Privacy', 'Contact Management',
]

function stripSections(md: string): string {
  const lines = md.split('\n')
  const result: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      const heading = line.replace(/^## /, '').trim()
      skipping = STRIP_SECTIONS.includes(heading)
    }
    if (!skipping) result.push(line)
  }
  return result.join('\n').trim()
}

// --- Atoms API ---

async function atomsApi(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const apiKey = process.env.ATOMS_API_KEY
  if (!apiKey) return { ok: false, status: 0, data: { error: 'ATOMS_API_KEY not set' } }
  const res = await fetch(`${ATOMS_API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) }
}

// --- Voice prompt sync ---

export async function buildVoicePrompt(callContext?: string): Promise<string> {
  const alMd = (await readIfExists(join(WORKSPACE_DIR, 'AL.md'))) || ''
  const stripped = stripSections(alMd)

  // Owner context — strip frontmatter
  const yousefRaw = (await readIfExists(join(WORKSPACE_DIR, 'users', 'yousef.md'))) || ''
  const yousefMd = yousefRaw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim()

  const parts = [VOICE_PREAMBLE, stripped, yousefMd]
  if (callContext) {
    parts.push(`## Call Task\n\nThis is an outbound call. Your specific task for this call:\n${callContext}`)
  }
  return parts.filter(Boolean).join('\n\n---\n\n')
}

export async function syncVoicePrompt(callContext?: string): Promise<void> {
  const agentId = process.env.ATOMS_AGENT_ID
  if (!agentId) {
    console.error('[al/voice] ATOMS_AGENT_ID not set')
    return
  }
  const prompt = await buildVoicePrompt(callContext)

  const agentResult = await atomsApi('GET', `/agent/${agentId}`)
  if (!agentResult.ok) {
    console.error(`[al/voice] failed to get agent: ${agentResult.status}`)
    return
  }
  const workflowId = agentResult.data?.data?.workflowId
  if (!workflowId) {
    console.error('[al/voice] agent has no workflowId')
    return
  }

  const tools = [
    {
      name: 'end_call',
      description: 'Terminate the call when conversation is complete.',
      type: 'end_call',
      enabled: true,
    },
    {
      name: 'delegate',
      description: 'Delegate a task to your text-based self. Use this for anything beyond simple conversation: running commands, looking things up, checking calendar, scheduling, messaging, reading or editing files, etc. Pass the caller\'s request clearly.',
      type: 'api_call',
      enabled: true,
      url: 'https://al.amar.io/voice/delegate',
      method: 'POST',
      timeout: 30000,
      llmParameters: [
        { name: 'request', description: 'The task or question to delegate to the text agent', type: 'text', required: true },
      ],
      headers: { 'Content-Type': 'application/json' },
      requestBody: '{"request": "{{request}}", "callerPhone": "{{user_number}}", "callId": "{{call_id}}"}',
      responseVariables: [],
    },
  ]

  const result = await atomsApi('PATCH', `/workflow/${workflowId}`, {
    type: 'single_prompt',
    singlePromptConfig: { prompt, tools },
  })
  if (!result.ok) console.error(`[al/voice] sync failed: ${result.status}`)
  else console.log('[al/voice] prompt synced to Atoms')
}

// --- Delegate (Atoms → Al) ---

/**
 * Inject the caller's request into the Al session and capture the next
 * assistant turn's text. Bounded by `timeoutMs` since Atoms's delegate call
 * has a hard 30s timeout on its side.
 */
export function handleDelegate(
  alSession: Session,
  callerPhone: string,
  text: string,
  resolvedUser: string | null,
  timeoutMs = 25_000,
): Promise<string> {
  return new Promise((resolve) => {
    const user = resolvedUser ?? callerPhone
    const envelope = [
      `[Voice delegate from ${user} (phone: ${callerPhone})]`,
      'Reply with ONLY the answer text. No markdown, no bullets, no URLs — your reply will be spoken aloud to the caller. Be concise; the caller is waiting in real time.',
      '',
      text,
    ].join('\n')

    const texts: string[] = []
    let settled = false

    const finish = (out: string) => {
      if (settled) return
      settled = true
      try { alSession.off('hub_message', listener) } catch { /* noop */ }
      clearTimeout(hardTimer)
      resolve(out)
    }

    const listener = (msg: HubMessage) => {
      if (msg.type === 'text' && 'content' in msg) {
        const c = (msg as { content?: string }).content
        if (typeof c === 'string') texts.push(c)
      }
      if (msg.type === 'result' || msg.type === 'session_ended') {
        finish(texts.join('\n').trim() || '(no response)')
      }
    }

    alSession.on('hub_message', listener)
    const hardTimer = setTimeout(() => finish(texts.join('\n').trim() || '(timed out)'), timeoutMs)

    try {
      alSession.sendMessage(envelope)
    } catch (err) {
      finish(`(delegate error: ${(err as Error)?.message ?? 'unknown'})`)
    }
  })
}

// --- Outbound calls ---

export async function makeOutboundCall(
  phoneNumber: string,
  context: string,
): Promise<{ callId?: string; error?: string }> {
  const agentId = process.env.ATOMS_AGENT_ID
  if (!agentId) return { error: 'ATOMS_AGENT_ID not set' }
  await syncVoicePrompt(context)

  const result = await atomsApi('POST', '/conversation/outbound', { agentId, phoneNumber })
  if (!result.ok) {
    const msg = result.data?.message ?? result.data?.error ?? JSON.stringify(result.data)
    console.error(`[al/voice] outbound call failed: ${msg}`)
    return { error: msg }
  }
  const responseData = result.data?.data ?? result.data
  const callId = responseData?.callId ?? responseData?.conversationId ?? responseData?.id
  if (!callId) {
    return { error: `No callId in Atoms response: ${JSON.stringify(result.data)}` }
  }
  console.log(`[al/voice] outbound call initiated: ${callId} → ${phoneNumber}`)
  pollForTranscript(callId).catch((err) => console.error('[al/voice] polling failed:', (err as Error)?.message))
  return { callId }
}

async function pollForTranscript(callId: string): Promise<void> {
  const POLL_INTERVAL = 15_000
  const MAX_POLLS = 20
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    const details = await atomsApi('GET', `/analytics/conversation-details/${encodeURIComponent(callId)}`)
    if (!details.ok) continue
    const data = details.data?.data ?? details.data
    if (data?.callStatus !== 'completed') continue
    await handleWebhook({ event: 'call.end', callId })
    return
  }
  console.log(`[al/voice] polling timed out for ${callId}`)
}

// --- Webhook (Atoms → hub) ---

export async function handleWebhook(payload: any): Promise<void> {
  const eventType = payload?.event ?? payload?.type ?? 'unknown'
  const callId = payload?.callId ?? payload?.conversationId ?? payload?.data?.callId ?? payload?.data?.conversationId
  console.log(`[al/voice] webhook: ${eventType} (callId=${callId})`)

  if (eventType === 'call.start' || eventType === 'start') return
  if (eventType === 'analytics.completed' || eventType === 'analytics_completed') return
  if (!callId) {
    console.error(`[al/voice] webhook with no callId: ${JSON.stringify(payload).slice(0, 200)}`)
    return
  }

  const details = await atomsApi('GET', `/analytics/conversation-details/${encodeURIComponent(callId)}`)
  if (!details.ok) return
  const data = details.data?.data ?? details.data
  if (!data?.transcript?.length) return

  try {
    await mkdir(TRANSCRIPTS_DIR, { recursive: true })
    await writeFile(
      join(TRANSCRIPTS_DIR, `${callId}.json`),
      JSON.stringify({
        callId,
        from: data?.fromNumber ?? 'unknown',
        to: data?.toNumber ?? 'unknown',
        duration: data?.callDurationMs ? `${Math.round(data.callDurationMs / 1000)}s` : 'unknown',
        timestamp: data?.timestamp,
        transcript: data.transcript,
      }, null, 2),
      'utf-8',
    )
    console.log(`[al/voice] transcript saved: ${callId} (${data.transcript.length} messages)`)
  } catch (err) {
    console.error('[al/voice] failed to save transcript:', (err as Error)?.message)
  }
}
