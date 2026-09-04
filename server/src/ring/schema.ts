// Ring command schema — the "command tree" as DATA, read from a vault note.
//
// Handlers (what `add`/`start`/`message`/`echo`/`music` DO) live in code; the
// PHRASING lives in `projects/console/ring-schema.md`: verb aliases (STT
// mangles discovered over time), targets and their spoken aliases, contacts
// and their nicknames. Shape is always `canonical: [aliases…]` — one key, a
// list of ways to say it. The note carries a ```yaml fence so Yousef edits the
// tree in the Notes/Spaces editor; prose around the fence is his. Parse
// errors keep the last good schema (never a silent fallback to defaults
// mid-flight) and surface via `con ring schema --check`.

import { parse as parseYaml } from 'yaml'

export const RING_SCHEMA_NOTE = 'projects/console/ring-schema.md'
/** Every list/log lives here unless the target names its own file. */
export const LISTS_DIR = 'scratch/lists'

/** A list and a log are the same thing — a note we append bullets to. `dated`
 *  is what makes it a log: a `## YYYY-MM-DD` heading per day + `HH:MM` stamps. */
export interface ListTarget {
  file: string
  dated: boolean
  /** Optional LLM enrichment step ("movie" → title/year/series table row). */
  enrich?: 'movie'
  aliases: string[]
}

export interface RingSchema {
  /** agentKey that receives anything no verb claims. null = only notify. */
  fallback: string | null
  /** Consult the LLM classifier before falling back. */
  llmFallback: boolean
  verbs: {
    /** add|log <target> <text> — a list target, or a project slug (→ card). */
    add: { aliases: string[]; targets: Record<string, ListTarget>; projectColumn: string }
    /** start <project> <text> → card straight into the dispatch column (forks an agent now). */
    start: { aliases: string[]; column: string }
    /** message <person> <text> → sent AS Yousef via his own chat account. contacts: username → spoken forms. */
    message: { aliases: string[]; contacts: Record<string, string[]> }
    /** echo <text> → the payload lands on Yousef's WhatsApp, no LLM — the smoke test. */
    echo: { aliases: string[] }
    music: { aliases: string[]; enabled: boolean }
  }
}

export function defaultListFile(name: string): string {
  return `${LISTS_DIR}/${name}.md`
}

export const DEFAULT_SCHEMA: RingSchema = {
  fallback: 'al',
  llmFallback: true,
  verbs: {
    add: {
      aliases: ['log', 'ad', 'at', 'lock', 'blog', 'note'],
      targets: {
        dream: { file: defaultListFile('dream'), dated: true, aliases: ['dreams', 'dreem'] },
        journal: { file: defaultListFile('journal'), dated: true, aliases: ['journey', 'diary'] },
        emotion: { file: defaultListFile('emotion'), dated: true, aliases: ['emotions', 'feeling', 'feelings', 'system'] },
        movies: { file: `${LISTS_DIR}/movie-list.md`, dated: false, enrich: 'movie', aliases: ['movie', 'film', 'films'] },
        reading: { file: `${LISTS_DIR}/reading-list.md`, dated: false, aliases: ['books', 'book', 'read'] },
        games: { file: `${LISTS_DIR}/game-list.md`, dated: false, aliases: ['game'] },
        groceries: { file: defaultListFile('groceries'), dated: false, aliases: ['grocery', 'shopping'] },
      },
      projectColumn: 'Backlog',
    },
    start: { aliases: ['do', 'go', 'kick', 'begin', 'now'], column: 'In Progress' },
    message: { aliases: ['text', 'whatsapp', 'tell'], contacts: {} },
    echo: { aliases: ['test', 'ping', 'repeat'] },
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
  if (typeof v === 'string') return v.trim() ? [v.toLowerCase().trim()] : []
  if (!Array.isArray(v)) { errors.push(`${path}: expected a list`); return [] }
  return v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map((s) => String(s).toLowerCase().trim()).filter(Boolean)
}

/** `canonical: [aliases…]` mappings (contacts). A string value is the OLD
 *  `nickname: canonical` shape — reject it loudly rather than invert it. */
function aliasMap(v: unknown, path: string, errors: string[]): Record<string, string[]> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${path}: expected a mapping of canonical → [aliases]`); return {} }
  const out: Record<string, string[]> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.toLowerCase().trim()
    if (typeof val === 'string') { errors.push(`${path}.${k}: expected a LIST of spoken forms (the shape is \`${k}: [${val}, …]\`, canonical first)`); continue }
    out[key] = strList(val, `${path}.${k}`, errors)
  }
  return out
}

function parseTargets(v: unknown, errors: string[]): Record<string, ListTarget> {
  const out: Record<string, ListTarget> = {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) { errors.push('verbs.add.targets: expected a mapping'); return out }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const name = k.toLowerCase().trim()
    if (!/^[a-z][a-z0-9-]*$/.test(name)) { errors.push(`verbs.add.targets.${k}: names are lowercase words (a-z, 0-9, -)`); continue }
    if (val === null || val === undefined || val === true) { out[name] = { file: defaultListFile(name), dated: false, aliases: [] }; continue }
    if (typeof val === 'string') { out[name] = { file: val.trim(), dated: false, aliases: [] }; continue }
    if (typeof val !== 'object' || Array.isArray(val)) { errors.push(`verbs.add.targets.${k}: expected a path or {file, dated, enrich, aliases}`); continue }
    const t = val as { file?: unknown; dated?: unknown; enrich?: unknown; aliases?: unknown }
    const target: ListTarget = {
      file: typeof t.file === 'string' && t.file.trim() ? t.file.trim() : defaultListFile(name),
      dated: t.dated === true,
      aliases: strList(t.aliases, `verbs.add.targets.${k}.aliases`, errors),
    }
    if (t.enrich !== undefined) {
      if (t.enrich === 'movie') target.enrich = 'movie'
      else errors.push(`verbs.add.targets.${k}.enrich: unknown enricher "${String(t.enrich)}" (known: movie)`)
    }
    out[name] = target
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
  const add = verbs.add ?? {}
  const start = verbs.start ?? {}
  const message = verbs.message ?? {}
  const echo = verbs.echo ?? {}
  const music = verbs.music ?? {}

  const schema: RingSchema = {
    fallback: r.fallback === null ? null : typeof r.fallback === 'string' ? r.fallback.toLowerCase().trim() || null : DEFAULT_SCHEMA.fallback,
    llmFallback: typeof r.llm_fallback === 'boolean' ? r.llm_fallback : DEFAULT_SCHEMA.llmFallback,
    verbs: {
      add: {
        aliases: add.aliases === undefined ? [...d.add.aliases] : strList(add.aliases, 'verbs.add.aliases', errors),
        targets: add.targets === undefined ? structuredClone(d.add.targets) : parseTargets(add.targets, errors),
        projectColumn: typeof add.project_column === 'string' && add.project_column.trim() ? add.project_column.trim() : d.add.projectColumn,
      },
      start: {
        aliases: start.aliases === undefined ? [...d.start.aliases] : strList(start.aliases, 'verbs.start.aliases', errors),
        column: typeof start.column === 'string' && start.column.trim() ? start.column.trim() : d.start.column,
      },
      message: {
        aliases: message.aliases === undefined ? [...d.message.aliases] : strList(message.aliases, 'verbs.message.aliases', errors),
        contacts: aliasMap(message.contacts, 'verbs.message.contacts', errors),
      },
      echo: {
        aliases: echo.aliases === undefined ? [...d.echo.aliases] : strList(echo.aliases, 'verbs.echo.aliases', errors),
      },
      music: {
        aliases: strList(music.aliases, 'verbs.music.aliases', errors),
        enabled: typeof music.enabled === 'boolean' ? music.enabled : true,
      },
    },
  }
  for (const k of Object.keys(verbs)) if (!(k in d)) errors.push(`verbs.${k}: unknown verb (handlers are code — known: ${Object.keys(d).join(', ')})`)
  // A spoken form claimed twice is ambiguous at match time — say so up front.
  const seen = new Map<string, string>()
  const claim = (token: string, owner: string) => {
    const prev = seen.get(token)
    if (prev && prev !== owner) errors.push(`"${token}" is claimed by both ${prev} and ${owner}`)
    seen.set(token, owner)
  }
  for (const [name, t] of Object.entries(schema.verbs.add.targets)) { claim(name, `target ${name}`); for (const a of t.aliases) claim(a, `target ${name}`) }
  const contactsSeen = new Map<string, string>()
  for (const [user, forms] of Object.entries(schema.verbs.message.contacts)) {
    for (const f of [user, ...forms]) {
      const prev = contactsSeen.get(f)
      if (prev && prev !== user) errors.push(`"${f}" is claimed by both contacts ${prev} and ${user}`)
      contactsSeen.set(f, user)
    }
  }
  return { schema, errors, found: true }
}

/** Every spoken form → canonical name, for a `canonical: {aliases}` table. */
export function spokenForms(targets: Record<string, { aliases: string[] }>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, t] of Object.entries(targets)) { out.set(name, name); for (const a of t.aliases) out.set(a, name) }
  return out
}

/** Same for contacts (`username: [forms]`). Yousef calls people by their
 *  FIRST name, so a hyphenated username's first segment (`sam-miller` → `sam`)
 *  is a spoken form automatically — when only one contact owns it. `allUsers`
 *  (every users/*.md, not just the listed ones) makes that uniqueness check
 *  honest. */
export function contactForms(contacts: Record<string, string[]>, allUsers: string[] = []): Map<string, string> {
  const out = new Map<string, string>()
  const firstNames = new Map<string, Set<string>>()
  for (const user of new Set([...Object.keys(contacts), ...allUsers])) {
    const first = user.split('-')[0]!
    if (first && first !== user && !/^\d/.test(first)) firstNames.set(first, new Set([...(firstNames.get(first) ?? []), user]))
  }
  for (const [user, forms] of Object.entries(contacts)) { out.set(user, user); for (const f of forms) out.set(f, user) }
  for (const [first, owners] of firstNames) {
    if (owners.size === 1 && !out.has(first)) out.set(first, [...owners][0]!)
  }
  return out
}

/** The note seeded into the vault when none exists — Yousef's editable copy.
 *  Contacts are left generic here (this file is in a public repo); the live
 *  note carries the real nicknames. */
export function seedSchemaNote(): string {
  return `---
title: Ring command tree
---
The Pebble Index 01 ring routes every recording through this tree (pure string
parsing; the LLM only rescues a mis-transcription; anything unclaimed goes to
the fallback agent — an \`AL ↔ ring\` fork that knows this tree and files a
"Ring schema gap" card when a miss should have been a command). Handlers are
code — this note owns the PHRASING. Every entry is \`canonical: [ways to say it]\`.
Edit the yaml, the hub hot-reloads it. Check it with \`con ring schema --check\`;
dry-run a phrase with \`con ring say "…"\`.

Shape: \`<verb> <target> <payload>\`. A list and a log are the same thing — a
note under \`scratch/lists/\` we append a bullet to; \`dated: true\` makes it a log
(\`## YYYY-MM-DD\` heading per day, \`- HH:MM text\` bullets). \`add\` and \`log\` are
the same verb. Examples: \`log dream I was escaping a prison made of cheese\`,
\`add movies Spiderman\`, \`log journal just finished sowing the seeds\`,
\`message mum I'll be home in 30 mins\`, \`add console the login button is
misaligned\` (a project slug → Backlog card), \`start console fix the login
button\` (→ In Progress, an agent forks now), \`echo testing one two\` (→ your own
WhatsApp, pure software — the smoke test).

\`\`\`yaml
fallback: al            # agentKey for anything no verb claims; null = only notify
llm_fallback: true      # consult the LLM classifier before falling back

verbs:
  add:                  # add|log <target> <text>
    aliases: [log, ad, at, lock, blog, note]
    targets:            # file defaults to scratch/lists/<name>.md; a project slug instead → board card
      dream:     { dated: true,  aliases: [dreams, dreem] }
      journal:   { dated: true,  aliases: [journey, diary] }
      emotion:   { dated: true,  aliases: [emotions, feeling, feelings, system] }
      movies:    { file: scratch/lists/movie-list.md, enrich: movie, aliases: [movie, film, films] }
      reading:   { file: scratch/lists/reading-list.md, aliases: [books, book, read] }
      games:     { file: scratch/lists/game-list.md, aliases: [game] }
      groceries: { aliases: [grocery, shopping] }
    project_column: Backlog   # add <project> … lands here (queued for triage)

  start:                # start <project> <text> → card straight into the dispatch column
    aliases: [do, go, kick, begin, now]
    column: In Progress     # the board watcher dispatches it → an agent forks now

  message:              # message <person> <text> → sent AS YOU through your own chat (Beeper WhatsApp DM)
    aliases: [text, whatsapp, tell]
    contacts:           # users/<name>.md in AL's workspace → spoken forms (matched lowercased, one edit tolerated)
      # a hyphenated username's first name is understood automatically (sam-miller ← sam)
      # mai: [mum, mom, mother]

  echo:                 # echo <text> → straight to your own WhatsApp, no LLM
    aliases: [test, ping, repeat]

  music:                # play | pause | next | previous | play <query>
    enabled: true
\`\`\`
`
}

// --------------------------------------------------------------------------
// Effective-tree description — what `con ring schema` prints.
// --------------------------------------------------------------------------

export interface SchemaTargetStatus { name: string; aliases: string[]; resolves: string; ok: boolean; note?: string }
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
  env: { projects: string[]; contacts: string[]; agents: Array<{ agentKey: string | null }>; echoConfigured: boolean },
  exists: (vaultPath: string) => Promise<boolean>,
): Promise<SchemaDescription> {
  const v = loaded.schema.verbs
  const liveKey = (key: string | null) => !!key && env.agents.some((a) => a.agentKey?.toLowerCase() === key.toLowerCase())
  const listTargets = await Promise.all(Object.entries(v.add.targets).map(async ([name, t]) => {
    const ok = await exists(t.file)
    return {
      name, aliases: t.aliases,
      resolves: `${t.dated ? 'log ' : 'list '}${t.file}${t.enrich ? ` (enrich: ${t.enrich})` : ''}`,
      ok: true,
      ...(ok ? {} : { note: 'file will be created on first use' }),
    }
  }))
  const projectTargets = env.projects.map((p) => ({ name: p, aliases: [], resolves: `board card → ${v.add.projectColumn}`, ok: true }))
  const derived = contactForms(v.message.contacts, env.contacts)
  const contacts = Object.entries(v.message.contacts).map(([user, forms]) => {
    const ok = env.contacts.includes(user)
    const first = [...derived].filter(([f, u]) => u === user && f !== user && !forms.includes(f)).map(([f]) => f)
    return { name: user, aliases: [...first, ...forms], resolves: `users/${user}.md`, ok, ...(ok ? {} : { note: 'no such contact in AL\'s workspace' }) }
  })
  return {
    path: loaded.path,
    errors: loaded.errors,
    stale: loaded.stale,
    fallback: { agentKey: loaded.schema.fallback, live: liveKey(loaded.schema.fallback) },
    llmFallback: loaded.schema.llmFallback,
    verbs: [
      { verb: 'add', aliases: v.add.aliases, usage: 'add|log <target> <text>', targets: [...listTargets, ...projectTargets] },
      { verb: 'start', aliases: v.start.aliases, usage: 'start <project> <text>', targets: env.projects.map((p) => ({ name: p, aliases: [], resolves: `board card → ${v.start.column} (dispatches now)`, ok: true })) },
      { verb: 'message', aliases: v.message.aliases, usage: 'message <person> <text>', targets: contacts, note: `also any of: ${env.contacts.join(', ') || '-'}` },
      { verb: 'echo', aliases: v.echo.aliases, usage: 'echo <text>', targets: [], ...(env.echoConfigured ? {} : { note: 'NOTIFY_JID unset — echo has nowhere to send' }) },
      { verb: 'music', aliases: v.music.aliases, usage: 'play | pause | next | previous | play <query>', targets: [], ...(v.music.enabled ? {} : { note: 'disabled' }) },
    ],
  }
}
