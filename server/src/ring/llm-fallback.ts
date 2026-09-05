// LLM fallback for the ring router — consulted ONLY when routeByRules()
// finds nothing, to rescue a mis-transcribed command (a mangled verb or
// target the alias table didn't anticipate, a paraphrase). One-shot
// `claude -p` on the small/fast model, same pattern as /blog/format. The
// model may only pick from the tree the rules already implement — it never
// invents a command kind or a target that isn't in the schema/env.

import { execFile } from 'node:child_process'
import type { RingCommand, RouteEnv } from './router.js'
import { AL_CONTACT, type RingSchema } from './schema.js'
import type { MovieRow } from './append.js'

const TIMEOUT_MS = 20_000

export function buildClassifyPrompt(text: string, schema: RingSchema, env: RouteEnv): string {
  const v = schema.verbs
  return [
    'You classify a short voice-command transcript from a smart ring into ONE command from a fixed tree. The transcript may be mis-transcribed (homophones, dropped words, mangled names) — infer the intended command generously but never invent content that is not there, and never pick a target outside the lists below.',
    '',
    'Tree: <verb> <target> <payload>. Output exactly one JSON object, nothing else:',
    `  {"kind":"list","target":"<one of: ${Object.keys(v.add.targets).join(', ') || '-'}>","item":"<payload>"}`,
    `  {"kind":"card","project":"<one of: ${env.projects.join(', ') || '-'}>","text":"<payload>","start":<true only if the speaker clearly wants work to begin NOW (verbs like start/do/go/kick off), else false>}`,
    `  {"kind":"message","contact":"<one of: ${[...new Set([...Object.keys(v.message.contacts), ...env.contacts])].join(', ') || '-'}>","text":"<payload>"}`,
    '  {"kind":"echo","text":"<payload>"}',
    '  {"kind":"music","action":"play"|"pause"|"next"|"previous","query":"<optional: what to play>"}',
    '  {"kind":"unknown"}',
    '',
    `Spoken aliases: add/log=${v.add.aliases.join('/') || '-'}; start=${v.start.aliases.join('/') || '-'}; message=${v.message.aliases.join('/') || '-'}; echo=${v.echo.aliases.join('/') || '-'}. Target aliases: ${Object.entries(v.add.targets).map(([n, t]) => `${n}←${t.aliases.join('/') || '-'}`).join(', ')}. Contact nicknames: ${Object.entries(v.message.contacts).map(([u, f]) => `${u}←${f.join('/') || '-'}`).join(', ') || '-'}.`,
    '',
    `Transcript: ${JSON.stringify(text)}`,
    '',
    'JSON:',
  ].join('\n')
}

/** Parse the model's reply into a RingCommand, or null on anything off-schema. */
export function parseClassifyReply(reply: string, schema: RingSchema, env: RouteEnv, text: string): RingCommand | null {
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return null
  let obj: Record<string, unknown>
  try { obj = JSON.parse(m[0]) as Record<string, unknown> } catch { return null }
  const str = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : '')
  const v = schema.verbs
  switch (obj.kind) {
    case 'list': {
      const target = str('target').toLowerCase(); const item = str('item')
      const t = v.add.targets[target]
      return t && item ? { kind: 'list', target, file: t.file, item, dated: t.dated, ...(t.enrich ? { enrich: t.enrich } : {}) } : null
    }
    case 'echo': {
      const t = str('text')
      return t ? { kind: 'echo', text: t } : null
    }
    case 'card': {
      const project = str('project').toLowerCase(); const t = str('text')
      return env.projects.includes(project) && t ? { kind: 'card', project, column: obj.start === true ? v.start.column : v.add.projectColumn, text: t } : null
    }
    case 'message': {
      const contact = str('contact').toLowerCase(); const t = str('text')
      const known = contact in v.message.contacts || env.contacts.includes(contact)
      if (!known || !t) return null
      // Same as the rule router: addressing AL is a conversation, not a send.
      if (contact === AL_CONTACT) return { kind: 'fallback', agentKey: AL_CONTACT, text: t }
      return { kind: 'message', contact, spoken: contact, text: t }
    }
    case 'music': {
      const action = obj.action
      if (action !== 'play' && action !== 'pause' && action !== 'next' && action !== 'previous') return null
      const query = str('query')
      return { kind: 'music', action, ...(query ? { query } : {}) }
    }
    case 'unknown': return { kind: 'unknown', text }
    default: return null
  }
}

function claudeOneShot(prompt: string, model: string): Promise<string | null> {
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

export function buildMoviePrompt(text: string): string {
  return [
    'A user spoke the name of a film or TV series to add to their watch list. Identify it and reply with exactly one JSON object, nothing else:',
    '  {"title":"<canonical title>","year":"<first release year, 4 digits>","series":"No" | "Yes" | "Yes (<network or season note>)"}',
    'If you genuinely cannot identify it, use the spoken text as the title and "" for year.',
    '',
    `Spoken: ${JSON.stringify(text)}`,
    'JSON:',
  ].join('\n')
}

export function parseMovieReply(reply: string, fallbackTitle: string): MovieRow | null {
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { title?: unknown; year?: unknown; series?: unknown }
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : fallbackTitle
    const year = typeof o.year === 'string' || typeof o.year === 'number' ? String(o.year).trim() : ''
    const series = typeof o.series === 'string' && o.series.trim() ? o.series.trim() : 'No'
    return { title, year, series }
  } catch { return null }
}

export async function enrichMovieWithLlm(text: string, model: string): Promise<MovieRow | null> {
  const reply = await claudeOneShot(buildMoviePrompt(text), model)
  return reply ? parseMovieReply(reply, text) : null
}
