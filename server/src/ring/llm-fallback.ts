// LLM fallback for the ring router — consulted ONLY when routeByRules()
// finds nothing, to rescue a mis-transcribed command (a mangled verb or
// target the alias table didn't anticipate, a paraphrase). One-shot
// `claude -p` on the small/fast model, same pattern as /blog/format. The
// model may only pick from the tree the rules already implement — it never
// invents a command kind or a target that isn't in the schema/env.
//
// The model only CLASSIFIES. It names the command and the transcript's
// opening words that ARE the command (`lead_in`); the payload is always cut
// from the transcript itself, never written by the model — asked for the
// payload directly it returned a 40-word summary of a 200-word dream and
// that is what got logged (^green-carp).

import { execFile } from 'node:child_process'
import { normaliseKeepCase, stripLeadIn, isVerbatim, type RingCommand, type RouteEnv } from './router.js'
import type { RingSchema } from './schema.js'
import { parseReminder } from './remind.js'

const TIMEOUT_MS = 20_000

export function buildClassifyPrompt(text: string, schema: RingSchema, env: RouteEnv): string {
  const v = schema.verbs
  return [
    'You classify a voice-command transcript from a smart ring into ONE command from a fixed tree. The transcript may be mis-transcribed (homophones, dropped words, mangled names) — infer the intended command generously, but never pick a target outside the lists below.',
    '',
    'You only CLASSIFY. You never write the payload — the hub cuts it from the transcript itself. For each command return "lead_in": the transcript\'s opening words that are the command wording (verb, target, any address word or filler before them), copied EXACTLY as they appear and ending where the content begins — e.g. "Log dream." or "Look, these are three dreams." or "Message mum,". Never summarise, rewrite, shorten or paraphrase the transcript, and never return any of its content.',
    '',
    'Tree: <verb> <target> <payload>. Output exactly one JSON object, nothing else:',
    `  {"kind":"list","target":"<one of: ${Object.keys(v.add.targets).join(', ') || '-'}>","lead_in":"<opening words>"}`,
    `  {"kind":"card","project":"<one of: ${env.projects.join(', ') || '-'}>","lead_in":"<opening words>","start":<true only if the speaker clearly wants work to begin NOW (verbs like start/do/go/kick off), else false>}`,
    `  {"kind":"message","contact":"<one of: ${[...new Set([...Object.keys(v.message.contacts), ...env.contacts])].join(', ') || '-'}>","lead_in":"<opening words>"}`,
    '  {"kind":"voice","contact":"<same contacts as message>","lead_in":"<opening words>"}   ← only when the speaker asks for a VOICE note / audio / recording to be sent, not a text',
    '  {"kind":"echo","lead_in":"<opening words>"}',
    '  {"kind":"remind","lead_in":"<opening words>"}   ← the speaker wants to be reminded of something later ("remind me…", "don\'t let me forget…"); lead_in ends where the thing to remember (or its time phrase) begins',
    '  {"kind":"music","action":"play"|"pause"|"next"|"previous","query":"<optional: the transcript\'s own words naming what to play, copied exactly>"}',
    '  {"kind":"unknown"}',
    '',
    `Spoken aliases: add/log=${v.add.aliases.join('/') || '-'}; start=${v.start.aliases.join('/') || '-'}; message=${v.message.aliases.join('/') || '-'}; voice=${v.voice.aliases.join('/') || '-'}; echo=${v.echo.aliases.join('/') || '-'}; remind=${v.remind.aliases.join('/') || '-'}. Target aliases: ${Object.entries(v.add.targets).map(([n, t]) => `${n}←${t.aliases.join('/') || '-'}`).join(', ')}. Contact nicknames: ${Object.entries(v.message.contacts).map(([u, f]) => `${u}←${f.join('/') || '-'}`).join(', ') || '-'}.`,
    '',
    `Transcript: ${JSON.stringify(text)}`,
    '',
    'JSON:',
  ].join('\n')
}

/** The payload is the transcript minus the model's lead-in. A legacy
 *  `item`/`text` is accepted only when it is a verbatim stretch of the
 *  transcript — a paraphrase is refused outright (null). When the lead-in is
 *  not actually a prefix (or is missing), `lenient` kinds — a log entry, a
 *  card, an echo — take the whole transcript so nothing is lost; a message
 *  never does: sending the command words to a contact is worse than handing
 *  the text to the fallback agent. */
export function payloadFor(text: string, leadIn: string, verbatim: string, lenient: boolean): string | null {
  const cased = normaliseKeepCase(text)
  if (verbatim && !leadIn) return isVerbatim(verbatim, text) ? verbatim : null
  const rest = leadIn ? stripLeadIn(cased, normaliseKeepCase(leadIn)) : null
  if (rest !== null) return rest
  return lenient ? cased : null
}

/** Parse the model's reply into a RingCommand, or null on anything off-schema. */
export function parseClassifyReply(reply: string, schema: RingSchema, env: RouteEnv, text: string): RingCommand | null {
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return null
  let obj: Record<string, unknown>
  try { obj = JSON.parse(m[0]) as Record<string, unknown> } catch { return null }
  const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : '')
  const payload = (legacyKey: 'item' | 'text', lenient: boolean) => payloadFor(text, str('lead_in'), str(legacyKey), lenient)
  const v = schema.verbs
  switch (obj.kind) {
    case 'list': {
      const target = str('target').toLowerCase(); const item = payload('item', true)
      const t = v.add.targets[target]
      return t && item ? { kind: 'list', target, file: t.file, item, dated: t.dated, ...(t.enrich ? { enrich: t.enrich } : {}) } : null
    }
    case 'echo': {
      const t = payload('text', true)
      return t ? { kind: 'echo', text: t } : null
    }
    case 'remind': {
      const t = payload('text', false)
      const parsed = t ? parseReminder(t, v.remind.defaultIn) : null
      return parsed ? { kind: 'remind', ...parsed } : null
    }
    case 'card': {
      const project = str('project').toLowerCase(); const t = payload('text', true)
      return env.projects.includes(project) && t ? { kind: 'card', project, column: obj.start === true ? v.start.column : v.add.projectColumn, text: t } : null
    }
    case 'message':
    case 'voice': {
      const contact = str('contact').toLowerCase(); const t = payload('text', false)
      const known = contact in v.message.contacts || env.contacts.includes(contact)
      return known && t ? { kind: obj.kind, contact, spoken: contact, text: t } : null
    }
    case 'music': {
      const action = obj.action
      if (action !== 'play' && action !== 'pause' && action !== 'next' && action !== 'previous') return null
      const query = str('query')
      if (query && !isVerbatim(query, text)) return null
      return { kind: 'music', action, ...(query ? { query } : {}) }
    }
    case 'unknown': return { kind: 'unknown', text }
    default: return null
  }
}

export function claudeOneShot(prompt: string, model: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('claude', ['-p', prompt, '--output-format', 'text', '--model', model], { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) { console.warn(`[ring] llm call failed: ${err.message.slice(0, 200)}`); resolve(null); return }
      resolve(String(stdout))
    })
  })
}

export async function classifyWithLlm(text: string, schema: RingSchema, env: RouteEnv, model: string): Promise<RingCommand | null> {
  const reply = await claudeOneShot(buildClassifyPrompt(text, schema, env), model)
  return reply ? parseClassifyReply(reply, schema, env, text) : null
}
