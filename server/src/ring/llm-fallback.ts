// LLM fallback for the ring router — consulted ONLY when routeByRules()
// finds nothing, to rescue a mis-transcribed command ("tell owl to..." the
// alias table didn't anticipate, a mangled agent name, a paraphrase). One-shot
// `claude -p` on the small/fast model, same pattern as /blog/format. The
// model may only pick from the schema the rules already implement — it never
// invents a command kind.

import { execFile } from 'node:child_process'
import type { RingAgent, RingCommand } from './router.js'

const TIMEOUT_MS = 20_000

export function buildClassifyPrompt(text: string, agents: RingAgent[]): string {
  const roster = agents.map((a) => `- id=${a.id} name="${a.name}"${a.agentKey ? ` key=${a.agentKey}` : ''}`).join('\n')
  return [
    'You classify a short voice-command transcript from a smart ring into ONE command. The transcript may be mis-transcribed (homophones, dropped words, mangled names) — infer the intended command generously but never invent content that is not there.',
    '',
    'Commands (output exactly one JSON object, nothing else):',
    '  {"kind":"agent","targetId":"<id from roster>","message":"<the message for that agent, verbatim minus the addressing words>"}',
    '  {"kind":"music","action":"play"|"pause"|"next"|"previous","query":"<optional: what to play>"}',
    '  {"kind":"unknown"}',
    '',
    'Agent roster (match spoken names loosely — "owl"/"hal" usually mean "AL"; "console" means "Console general"):',
    roster || '- (none)',
    '',
    `Transcript: ${JSON.stringify(text)}`,
    '',
    'JSON:',
  ].join('\n')
}

/** Parse the model's reply into a RingCommand, or null on anything off-schema. */
export function parseClassifyReply(reply: string, agents: RingAgent[], text: string): RingCommand | null {
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return null
  let obj: Record<string, unknown>
  try { obj = JSON.parse(m[0]) as Record<string, unknown> } catch { return null }
  switch (obj.kind) {
    case 'agent': {
      const a = agents.find((x) => x.id === obj.targetId)
      const message = typeof obj.message === 'string' ? obj.message.trim() : ''
      if (!a || !message) return null
      return { kind: 'agent', targetId: a.id, targetName: a.name, message }
    }
    case 'music': {
      const action = obj.action
      if (action !== 'play' && action !== 'pause' && action !== 'next' && action !== 'previous') return null
      const query = typeof obj.query === 'string' && obj.query.trim() ? obj.query.trim() : undefined
      return { kind: 'music', action, ...(query ? { query } : {}) }
    }
    case 'unknown': return { kind: 'unknown', text }
    default: return null
  }
}

export async function classifyWithLlm(text: string, agents: RingAgent[], model: string): Promise<RingCommand | null> {
  const prompt = buildClassifyPrompt(text, agents)
  const reply = await new Promise<string | null>((resolve) => {
    execFile('claude', ['-p', prompt, '--output-format', 'text', '--model', model], { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) { console.warn(`[ring] llm fallback failed: ${err.message.slice(0, 200)}`); resolve(null); return }
      resolve(String(stdout))
    })
  })
  if (!reply) return null
  return parseClassifyReply(reply, agents, text)
}
