// Give an agent its own email address, end to end, the way al@ and ceo@ were
// set up by hand: mailbox on mxroute → `~/.config/<name>-mail/.env` (what
// al-mail.py and the hub's IMAP IDLE watcher both read) → IMAP login verified
// → watcher hot-added → SKILL.md in the agent's cwd → `mail.received`
// listener on its session → one onboarding wake. Every step reports; a
// failure after the mailbox exists leaves it (and says so) rather than
// half-deleting.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountFromEnv, type ImapAccount } from '../imap/accounts.js'
import type { MxrouteClient, MxrouteEmailAccount } from '../mxroute/client.js'
import { MxrouteError, generateMailboxPassword } from '../mxroute/client.js'
import { renderInboxOnboarding, renderInboxSkill } from './inbox-skill.js'

export const INBOX_NAME_RE = /^[a-z][a-z0-9._-]{0,31}$/

export interface ProvisionInboxInput {
  /** Local part AND the `<name>` in `~/.config/<name>-mail`; `data.account` on events. */
  name: string
  domain?: string
  fromName?: string
  signature?: string
  quotaMb?: number
  /** Adopt a mailbox that already exists on mxroute (creation skipped). */
  password?: string
  /** Live session to educate: cwd for the skill file, owner of the listener, target of the wake. */
  agentKey?: string
  /** Where the SKILL.md goes when no agent session is given (a vault project slug). */
  project?: string
  /** Skip the onboarding wake (skill + listener still land). */
  quiet?: boolean
}

export interface ProvisionInboxResult {
  name: string
  address: string
  created: boolean
  envFile: string
  imap: { ok: boolean; attempts: number; error?: string }
  watcher: 'added' | 'already-live'
  skillFile: string | null
  listener: { id: string } | null
  wake: string | null
  warnings: string[]
}

export interface InboxSessionLike {
  claudeSessionId?: string | undefined
  agentKey?: string | undefined
  cwd: string
  status: string
}

export interface InboxDeps {
  mxroute: MxrouteClient
  configHome: string
  vaultProjects: string
  imapHost: string
  watcher: { has(name: string): boolean; addAccount(a: ImapAccount): void; removeAccount(name: string): void }
  liveSession: (agentKey: string) => InboxSessionLike | undefined
  addListener: (input: { owner: { claudeSessionId: string; agentKey?: string; cwd?: string }; on: string; where: string[]; name: string; action: { type: 'wake'; prompt: string } }) => { id: string }
  listenersFor: (name: string) => { id: string; owner: { claudeSessionId: string; cwd?: string | undefined } }[]
  removeListener: (id: string) => void
  wake: (session: InboxSessionLike, content: string) => string
  verifyImap: (account: ImapAccount) => Promise<void>
  random: (n: number) => Uint8Array
  sleep?: (ms: number) => Promise<void>
  log: (msg: string) => void
}

const IMAP_ATTEMPTS = 6
const IMAP_RETRY_MS = 3_000

function titleCase(s: string): string {
  return s.split(/[-_.]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')
}

/** Single-quoted, newlines as literal `\n` (al-mail.py unescapes them); `_kv` strips one outer quote pair and nothing else. */
function quoteEnv(v: string): string {
  return `'${v.replace(/\n/g, '\\n').replace(/'/g, '')}'`
}

export function envDir(configHome: string, name: string): string { return join(configHome, `${name}-mail`) }
export function skillPath(cwd: string, name: string): string { return join(cwd, '.claude', 'skills', `${name}-email`, 'SKILL.md') }

export function wakePrompt(name: string, address: string, skillFile: string | null): string {
  const skill = skillFile ? `the ${name}-email skill (${skillFile})` : `the ${name}-email skill in your cwd`
  return `New email arrived at ${address} (event payload above: uid, sender, subject, snippet). Read it with: python3 ~/exec/al-mail.py --account ${name} read <uid> --mark-read. Then act per ${skill}: reply from ${address} only within the send rules there (python3 ~/exec/al-mail.py --account ${name} send --to ... --subject ... --reply-to-id '<message-id>'), draft-and-ping Yousef for anything that commits him or comes from an unknown sender, ignore spam silently. Never send as Yousef from his accounts.`
}

export async function provisionInbox(input: ProvisionInboxInput, deps: InboxDeps): Promise<ProvisionInboxResult> {
  const name = input.name.trim().toLowerCase()
  if (!INBOX_NAME_RE.test(name)) throw new InboxError('VALIDATION', `name must match ${INBOX_NAME_RE} (it is the local part and the ~/.config/<name>-mail key): ${input.name}`)
  const domain = input.domain?.trim().toLowerCase() || deps.mxroute.domain
  const address = `${name}@${domain}`
  const fromName = input.fromName?.trim() || titleCase(name)
  const signature = input.signature !== undefined ? input.signature.replace(/\\n/g, '\n').trim() : `${fromName}\n\n${fromName} is an AI agent acting for Yousef Amar.`
  const dir = envDir(deps.configHome, name)
  const envFile = join(dir, '.env')
  const warnings: string[] = []

  if (existsSync(envFile)) throw new InboxError('CONFLICT', `${envFile} already exists — this mailbox is already configured locally (con agent inbox list). Remove it first if you mean to re-provision.`)

  const session = input.agentKey ? deps.liveSession(input.agentKey) : undefined
  if (input.agentKey && !session?.claudeSessionId) throw new InboxError('NOT_FOUND', `no live session with agentKey "${input.agentKey}" (con agent list)`)
  const csid = session?.claudeSessionId
  const skillCwd = session?.cwd ?? (input.project ? join(deps.vaultProjects, input.project) : null)
  if (input.project && !existsSync(join(deps.vaultProjects, input.project))) throw new InboxError('NOT_FOUND', `no vault project dir ${join(deps.vaultProjects, input.project)}`)

  // 1. The mailbox on mxroute.
  let password = input.password
  let created = false
  if (!password) {
    password = generateMailboxPassword(deps.random)
    try {
      await deps.mxroute.createEmailAccount({ username: name, password, quota: input.quotaMb ?? 1024 }, domain)
      created = true
      deps.log(`[inbox] created ${address} on mxroute`)
    } catch (err) {
      if (err instanceof MxrouteError && err.code === 'CONFLICT') {
        throw new InboxError('CONFLICT', `${address} already exists on mxroute but has no local config. To adopt it, re-run with --password '<its current password>' (or change it at panel.mxroute.com first).`)
      }
      throw err
    }
  }

  // 2. The .env both al-mail.py and the hub read.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const env = [
    `MAIL_HOST=${deps.imapHost}`,
    `MAIL_USER=${address}`,
    `MAIL_PASS=${quoteEnv(password)}`,
    `MAIL_FROM_NAME=${quoteEnv(fromName)}`,
    `MAIL_SIGNATURE=${quoteEnv(signature)}`,
    '',
  ].join('\n')
  writeFileSync(envFile, env, { mode: 0o600 })
  chmodSync(envFile, 0o600)
  const account = accountFromEnv(name, env)!

  // 3. Prove the credentials work (a fresh DirectAdmin mailbox can take a few seconds to exist on the IMAP side).
  const imap: ProvisionInboxResult['imap'] = { ok: false, attempts: 0 }
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  for (let i = 1; i <= IMAP_ATTEMPTS; i++) {
    imap.attempts = i
    try { await deps.verifyImap(account); imap.ok = true; delete imap.error; break } catch (err) {
      imap.error = (err as Error).message
      if (i < IMAP_ATTEMPTS) await sleep(IMAP_RETRY_MS)
    }
  }
  if (!imap.ok) warnings.push(`IMAP login to ${deps.imapHost} as ${address} failed after ${imap.attempts} attempts (${imap.error}). The .env is written; the watcher will keep retrying with backoff — check panel.mxroute.com if it never connects.`)

  // 4. Hot-add to the IDLE watcher.
  let watcher: ProvisionInboxResult['watcher'] = 'already-live'
  if (!deps.watcher.has(name)) { deps.watcher.addAccount(account); watcher = 'added' }

  // 5 + 6. Teach the agent: skill file in its cwd, listener on its session.
  let listener: { id: string } | null = null
  if (session) {
    if (deps.listenersFor(name).some((l) => l.owner.claudeSessionId === csid)) {
      warnings.push(`session ${csid!.slice(0, 8)} already has a mail.received listener for account ${name}; not adding another`)
    } else {
      listener = deps.addListener({
        owner: { claudeSessionId: csid!, ...(session.agentKey ? { agentKey: session.agentKey } : {}), cwd: session.cwd },
        on: 'mail.received',
        where: [`data.account=${name}`],
        name: `${name}@ mail (IDLE)`,
        action: { type: 'wake', prompt: wakePrompt(name, address, skillCwd ? skillPath(skillCwd, name) : null) },
      })
    }
  }
  let skillFile: string | null = null
  if (skillCwd) {
    skillFile = skillPath(skillCwd, name)
    mkdirSync(join(skillFile, '..'), { recursive: true })
    writeFileSync(skillFile, renderInboxSkill({ name, address, fromName, host: deps.imapHost, envFile, listenerId: listener?.id, signature }))
  } else {
    warnings.push('no --agent or --project given: no SKILL.md written and no listener registered — the mailbox works, but nobody has been told about it')
  }

  // 7. Tell it.
  let wake: string | null = null
  if (session && !input.quiet) {
    wake = deps.wake(session, renderInboxOnboarding({ address, skillFile: skillFile!, name, listenerId: listener?.id }))
  }

  return { name, address, created, envFile, imap, watcher, skillFile, listener, wake, warnings }
}

export interface RemoveInboxResult {
  name: string
  address: string | null
  mxroute: 'deleted' | 'kept' | 'absent'
  envRemoved: boolean
  listenersRemoved: string[]
  skillsRemoved: string[]
}

/** Undo `provisionInbox`. `--keep-mailbox` leaves the mxroute account (mail preserved); default deletes it. */
export async function removeInbox(name: string, opts: { keepMailbox?: boolean; domain?: string }, deps: InboxDeps): Promise<RemoveInboxResult> {
  if (!INBOX_NAME_RE.test(name)) throw new InboxError('VALIDATION', `bad name: ${name}`)
  const dir = envDir(deps.configHome, name)
  const envFile = join(dir, '.env')
  let address: string | null = null
  if (existsSync(envFile)) address = accountFromEnv(name, readFileSync(envFile, 'utf8'))?.user ?? null
  const domain = opts.domain ?? (address?.split('@')[1] || deps.mxroute.domain)
  address ??= `${name}@${domain}`

  let mxroute: RemoveInboxResult['mxroute'] = 'kept'
  if (!opts.keepMailbox) {
    try { await deps.mxroute.deleteEmailAccount(name, domain); mxroute = 'deleted' } catch (err) {
      if (err instanceof MxrouteError && err.code === 'NOT_FOUND') mxroute = 'absent'
      else throw err
    }
  }

  deps.watcher.removeAccount(name)
  const listeners = deps.listenersFor(name)
  const skillDirs = new Set<string>(allSessionCwds(deps))
  for (const l of listeners) if (l.owner.cwd) skillDirs.add(l.owner.cwd)
  const listenersRemoved = listeners.map((l) => { deps.removeListener(l.id); return l.id })
  const skillsRemoved: string[] = []
  for (const cwd of skillDirs) {
    const f = skillPath(cwd, name)
    if (existsSync(f)) { rmSync(join(f, '..'), { recursive: true, force: true }); skillsRemoved.push(f) }
  }
  let envRemoved = false
  if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); envRemoved = true }
  return { name, address, mxroute, envRemoved, listenersRemoved, skillsRemoved }
}

function allSessionCwds(deps: InboxDeps): string[] {
  const out: string[] = []
  if (existsSync(deps.vaultProjects)) {
    for (const e of readdirSync(deps.vaultProjects, { withFileTypes: true })) if (e.isDirectory()) out.push(join(deps.vaultProjects, e.name))
  }
  return out
}

export interface InboxListing {
  name: string
  address: string
  local: boolean
  watched: boolean
  mxroute: MxrouteEmailAccount | null
  listeners: string[]
}

/** Local `*-mail` configs joined with what mxroute reports for the domain. */
export async function listInboxes(deps: Pick<InboxDeps, 'configHome' | 'mxroute' | 'watcher' | 'listenersFor'>): Promise<{ domain: string; inboxes: InboxListing[]; mxrouteError?: string }> {
  const local = new Map<string, ImapAccount>()
  if (existsSync(deps.configHome)) {
    for (const e of readdirSync(deps.configHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('-mail')) continue
      const f = join(deps.configHome, e.name, '.env')
      if (!existsSync(f)) continue
      const a = accountFromEnv(e.name.slice(0, -5), readFileSync(f, 'utf8'))
      if (a) local.set(a.name, a)
    }
  }
  let remote: MxrouteEmailAccount[] = []
  let mxrouteError: string | undefined
  try { remote = await deps.mxroute.listEmailAccounts() } catch (err) { mxrouteError = (err as Error).message }
  const byAddress = new Map(remote.map((r) => [r.email.toLowerCase(), r]))
  const inboxes: InboxListing[] = []
  for (const [name, a] of local) {
    inboxes.push({ name, address: a.user, local: true, watched: deps.watcher.has(name), mxroute: byAddress.get(a.user.toLowerCase()) ?? null, listeners: deps.listenersFor(name).map((l) => l.id) })
    byAddress.delete(a.user.toLowerCase())
  }
  for (const r of byAddress.values()) inboxes.push({ name: r.username, address: r.email, local: false, watched: false, mxroute: r, listeners: [] })
  inboxes.sort((x, y) => x.name.localeCompare(y.name))
  return { domain: deps.mxroute.domain, inboxes, ...(mxrouteError ? { mxrouteError } : {}) }
}

export class InboxError extends Error {
  constructor(readonly code: 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'UNCONFIGURED', message: string) { super(message) }
  get status(): number { return this.code === 'VALIDATION' ? 400 : this.code === 'NOT_FOUND' ? 404 : this.code === 'CONFLICT' ? 409 : 503 }
}
