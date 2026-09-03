// Ring command schema — the "command tree" as DATA, read from a vault note.
//
// Handlers (what a `log`/`add`/`message`/`agent`/`music` DOES) live in code;
// the PHRASING lives in `projects/console/ring-schema.md`: verb aliases (STT
// mangles discovered over time), log/list targets → files, nickname →
// contact, spoken agent names. The note carries a ```yaml fence with the
// schema so Yousef edits the tree in the Notes/Spaces editor; prose around
// the fence is his. Parse errors keep the last good schema (never a silent
// fallback to defaults mid-flight) and surface via `con ring schema --check`.

import { parse as parseYaml } from 'yaml'

export const RING_SCHEMA_NOTE = 'projects/console/ring-schema.md'

export interface ListTarget {
  file: string
  /** Optional LLM enrichment step ("movie" → title/year/series table row). */
  enrich?: 'movie'
}

export interface RingSchema {
  /** agentKey that receives anything no verb claims. null = only notify. */
  fallback: string | null
  /** Consult the LLM classifier before falling back. */
  llmFallback: boolean
  verbs: {
    log: { aliases: string[]; targets: Record<string, string>; createUnknown: boolean }
    add: { aliases: string[]; targets: Record<string, ListTarget>; projectColumn: string }
    /** start <project> <text> → card straight into the dispatch column (forks an agent now). */
    start: { aliases: string[]; column: string }
    message: { aliases: string[]; contacts: Record<string, string> }
    music: { aliases: string[]; enabled: boolean }
  }
}

export const DEFAULT_SCHEMA: RingSchema = {
  fallback: 'al',
  llmFallback: true,
  verbs: {
    log: { aliases: [], targets: { dream: 'scratch/logs/dream.md' }, createUnknown: false },
    add: {
      aliases: ['ad'],
      targets: {
        movies: { file: 'scratch/lists/movie-list.md', enrich: 'movie' },
        reading: { file: 'scratch/lists/reading-list.md' },
        games: { file: 'scratch/lists/game-list.md' },
        groceries: { file: 'scratch/lists/groceries.md' },
      },
      projectColumn: 'Backlog',
    },
    start: { aliases: ['do', 'go', 'kick', 'begin', 'now'], column: 'In Progress' },
    message: { aliases: ['text', 'whatsapp', 'tell'], contacts: {} },
    music: { aliases: [], enabled: true },
  },
}

export interface SchemaParse {
  schema: RingSchema
  errors: string[]
  /** True when the note had a yaml fence at all. */
  found: boolean
}

function strList(v: unknown, path: string, errors: string[]): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) { errors.push(`${path}: expected a list`); return [] }
  return v.filter((x): x is string => typeof x === 'string').map((s) => s.toLowerCase().trim()).filter(Boolean)
}

function strMap(v: unknown, path: string, errors: string[]): Record<string, string> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${path}: expected a mapping`); return {} }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val.trim()) out[k.toLowerCase().trim()] = val.trim()
    else errors.push(`${path}.${k}: expected a string`)
  }
  return out
}

/** Parse the ```yaml fence out of the schema note. Missing fence → defaults
 *  (found:false); malformed → defaults + errors (callers keep last-good). */
export function parseSchemaNote(md: string): SchemaParse {
  const errors: string[] = []
  const fence = /```ya?ml\s*\n([\s\S]*?)\n```/.exec(md)
  if (!fence) return { schema: structuredClone(DEFAULT_SCHEMA), errors: ['no ```yaml fence in the schema note'], found: false }
  let raw: unknown
  try { raw = parseYaml(fence[1]!) } catch (e) {
    return { schema: structuredClone(DEFAULT_SCHEMA), errors: [`yaml: ${(e as Error).message.split('\n')[0]}`], found: true }
  }
  if (!raw || typeof raw !== 'object') return { schema: structuredClone(DEFAULT_SCHEMA), errors: ['yaml: top level must be a mapping'], found: true }
  const r = raw as Record<string, unknown>
  const verbs = (r.verbs && typeof r.verbs === 'object' ? r.verbs : {}) as Record<string, Record<string, unknown> | undefined>
  const d = DEFAULT_SCHEMA.verbs

  const log = verbs.log ?? {}
  const add = verbs.add ?? {}
  const start = verbs.start ?? {}
  const message = verbs.message ?? {}
  const music = verbs.music ?? {}

  const addTargets: Record<string, ListTarget> = {}
  if (add.targets !== undefined) {
    if (typeof add.targets !== 'object' || add.targets === null || Array.isArray(add.targets)) errors.push('verbs.add.targets: expected a mapping')
    else for (const [k, val] of Object.entries(add.targets as Record<string, unknown>)) {
      const key = k.toLowerCase().trim()
      if (typeof val === 'string' && val.trim()) addTargets[key] = { file: val.trim() }
      else if (val && typeof val === 'object' && typeof (val as { file?: unknown }).file === 'string') {
        const t = val as { file: string; enrich?: unknown }
        const target: ListTarget = { file: t.file.trim() }
        if (t.enrich !== undefined) {
          if (t.enrich === 'movie') target.enrich = 'movie'
          else errors.push(`verbs.add.targets.${k}.enrich: unknown enricher "${String(t.enrich)}" (known: movie)`)
        }
        addTargets[key] = target
      } else errors.push(`verbs.add.targets.${k}: expected a file path or {file, enrich}`)
    }
  }

  const schema: RingSchema = {
    fallback: r.fallback === null ? null : typeof r.fallback === 'string' ? r.fallback.toLowerCase().trim() || null : DEFAULT_SCHEMA.fallback,
    llmFallback: typeof r.llm_fallback === 'boolean' ? r.llm_fallback : DEFAULT_SCHEMA.llmFallback,
    verbs: {
      log: {
        aliases: strList(log.aliases, 'verbs.log.aliases', errors),
        targets: log.targets === undefined ? { ...d.log.targets } : strMap(log.targets, 'verbs.log.targets', errors),
        createUnknown: typeof log.create_unknown === 'boolean' ? log.create_unknown : d.log.createUnknown,
      },
      add: {
        aliases: add.aliases === undefined ? [...d.add.aliases] : strList(add.aliases, 'verbs.add.aliases', errors),
        targets: add.targets === undefined ? structuredClone(d.add.targets) : addTargets,
        projectColumn: typeof add.project_column === 'string' && add.project_column.trim() ? add.project_column.trim() : d.add.projectColumn,
      },
      start: {
        aliases: start.aliases === undefined ? [...d.start.aliases] : strList(start.aliases, 'verbs.start.aliases', errors),
        column: typeof start.column === 'string' && start.column.trim() ? start.column.trim() : d.start.column,
      },
      message: {
        aliases: message.aliases === undefined ? [...d.message.aliases] : strList(message.aliases, 'verbs.message.aliases', errors),
        contacts: strMap(message.contacts, 'verbs.message.contacts', errors),
      },
      music: {
        aliases: strList(music.aliases, 'verbs.music.aliases', errors),
        enabled: typeof music.enabled === 'boolean' ? music.enabled : true,
      },
    },
  }
  for (const k of Object.keys(verbs)) if (!(k in d)) errors.push(`verbs.${k}: unknown verb (handlers are code — known: ${Object.keys(d).join(', ')})`)
  return { schema, errors, found: true }
}

/** The note seeded into the vault when none exists — Yousef's editable copy. */
export function seedSchemaNote(): string {
  return `---
title: Ring command tree
---
The Pebble Index 01 ring routes every recording through this tree (pure string
parsing; the LLM only rescues a mis-transcription; anything unclaimed goes to
the fallback agent). Handlers are code — this note owns the PHRASING: verb
aliases, which word means which log/list/contact/agent. Edit the yaml, the hub
hot-reloads it. Check it with \`con ring schema --check\`; dry-run a phrase with
\`con ring say "…"\`.

Shape: \`<verb> <target> <payload>\` — e.g. \`log dream I was escaping a prison
made of cheese\`, \`add movies Spiderman\`, \`message mum I'll be home in 30 mins\`,
\`add console the login button is misaligned\` (a project name as the \`add\`
target files a card in Backlog — you talk to projects, not agents), \`start
console fix the login button\` (same, but straight into In Progress: the board
dispatches it and an agent forks for it now). Anything no verb claims goes to
the fallback agent.

\`\`\`yaml
fallback: al            # agentKey for anything no verb claims; null = only notify
llm_fallback: true      # consult the LLM classifier before falling back

verbs:
  log:                  # log <name> <text> → dated bullet appended to the file
    aliases: [lock, long, blog]
    targets:
      dream: scratch/logs/dream.md
    create_unknown: false   # true → "log foo …" creates scratch/logs/foo.md

  add:                  # add <list|project> <item>
    aliases: [ad, at]
    targets:            # lists (a project slug not listed here → board card)
      movies: { file: scratch/lists/movie-list.md, enrich: movie }
      reading: scratch/lists/reading-list.md
      games: scratch/lists/game-list.md
      groceries: scratch/lists/groceries.md
    project_column: Backlog   # add <project> … lands here (queued for triage)

  start:                # start <project> <text> → card straight into the dispatch column
    aliases: [do, go, kick, begin, now]
    column: In Progress     # the board watcher dispatches it → an agent forks now

  message:              # message <person> <text> → AL relays it on WhatsApp
    aliases: [text, whatsapp, tell]
    contacts:           # spoken name → users/<name>.md in AL's workspace
      # mum: some-user
      nica: nica

  music:                # play | pause | next | previous | play <query>
    enabled: true
\`\`\`
`
}

// --------------------------------------------------------------------------
// Effective-tree description — what `con ring schema` prints.
// --------------------------------------------------------------------------

export interface SchemaTargetStatus { name: string; resolves: string; ok: boolean; note?: string }
export interface SchemaDescription {
  path: string
  errors: string[]
  stale: boolean
  fallback: { agentKey: string | null; live: boolean }
  llmFallback: boolean
  verbs: Array<{ verb: string; aliases: string[]; usage: string; targets: SchemaTargetStatus[]; note?: string }>
}

export async function describeSchema(
  loaded: { schema: RingSchema; errors: string[]; stale: boolean; path: string },
  env: { projects: string[]; contacts: string[]; agents: Array<{ agentKey: string | null }> },
  exists: (vaultPath: string) => Promise<boolean>,
): Promise<SchemaDescription> {
  const v = loaded.schema.verbs
  const liveKey = (key: string | null) => !!key && env.agents.some((a) => a.agentKey?.toLowerCase() === key.toLowerCase())
  const fileTargets = async (map: Record<string, string>) => Promise.all(Object.entries(map).map(async ([name, file]) => {
    const ok = await exists(file)
    return { name, resolves: file, ok: true, ...(ok ? {} : { note: 'file will be created on first use' }) }
  }))
  const listTargets = await Promise.all(Object.entries(v.add.targets).map(async ([name, t]) => {
    const ok = await exists(t.file)
    return { name, resolves: `${t.file}${t.enrich ? ` (enrich: ${t.enrich})` : ''}`, ok: true, ...(ok ? {} : { note: 'file will be created on first use' }) }
  }))
  const projectTargets = env.projects.map((p) => ({ name: p, resolves: `board card → ${v.add.projectColumn}`, ok: true }))
  const contacts = Object.entries(v.message.contacts).map(([nick, user]) => {
    const ok = env.contacts.includes(user)
    return { name: nick, resolves: `users/${user}.md`, ok, ...(ok ? {} : { note: 'no such contact in AL\'s workspace' }) }
  })
  return {
    path: loaded.path,
    errors: loaded.errors,
    stale: loaded.stale,
    fallback: { agentKey: loaded.schema.fallback, live: liveKey(loaded.schema.fallback) },
    llmFallback: loaded.schema.llmFallback,
    verbs: [
      { verb: 'log', aliases: v.log.aliases, usage: 'log <name> <text>', targets: await fileTargets(v.log.targets), ...(v.log.createUnknown ? { note: 'unknown names create scratch/logs/<name>.md' } : {}) },
      { verb: 'add', aliases: v.add.aliases, usage: 'add <list|project> <item>', targets: [...listTargets, ...projectTargets] },
      { verb: 'start', aliases: v.start.aliases, usage: 'start <project> <text>', targets: env.projects.map((p) => ({ name: p, resolves: `board card → ${v.start.column} (dispatches now)`, ok: true })) },
      { verb: 'message', aliases: v.message.aliases, usage: 'message <person> <text>', targets: contacts, note: `also any of: ${env.contacts.join(', ') || '-'}` },
      { verb: 'music', aliases: v.music.aliases, usage: 'play | pause | next | previous | play <query>', targets: [], ...(v.music.enabled ? {} : { note: 'disabled' }) },
    ],
  }
}
