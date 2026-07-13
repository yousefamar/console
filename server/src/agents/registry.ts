// ============================================================================
// Agent role registry — the durable "org chart" layer.
//
// Each agent is a durable ROLE backed by an agent-owned markdown file at
// ~/.config/console/agents/<key>.md:
//
//   ---
//   title: Feeds tab
//   manager: al            # agentKey of this role's manager (the org edge)
//   goals:
//     - Keep the feeds pane fast
//   cwd: /home/amar/proj/code/console
//   created: 2026-06-15T...
//   ---
//   You are the Feeds agent. <charter prose>
//
//   ## Memory
//   - durable notes the agent maintains across sessions
//
// The AGENT maintains this file with normal file tools; the hub READS it (parses
// frontmatter for the org chart, injects the body as the system prompt on a fresh
// spawn) and NEVER clobbers the body. The only field the hub writes is `manager`
// (on a UI/CLI reparent), via a surgical single-line stamp — never a
// yaml round-trip, which would reorder keys / strip the agent's comments.
//
// Mirrors server/src/al/users.ts (boot dir-scan) + model-config.ts (atomic store).
// ============================================================================

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, watch } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface AgentRole {
  /** == filename without .md. Canonical, immutable. NEVER read from frontmatter. */
  key: string
  title: string
  /** agentKey of the org-parent, or null for a root. */
  manager: string | null
  goals: string[]
  cwd: string | null
  created: string | null
  /** The FULL markdown body verbatim (charter + ## Memory) — injected on fresh spawn. */
  charter: string
  hasFile: boolean
  /** True for an organization-only "folder" node: no session, no charter
   *  injection, not spawnable/revivable — just an org-chart container. */
  folder: boolean
  /** True for a role minted for a UI fork (seedRole). Forks are disposable —
   *  unlike a durable role, when a fork's session ends its role is DELETED, not
   *  parked (a parked fork is just chart clutter — there's nothing to revive it
   *  for). See kill_session/delete_session in routes/agents.ts. */
  fork: boolean
}

export interface OrgNode {
  role: AgentRole
  children: OrgNode[]
  /** Set when the role's `manager` points at a key that doesn't exist. */
  danglingManager?: string
  /** Set when the role was promoted to a root to break a manager cycle. */
  cycleBroken?: boolean
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

/** Lowercase kebab slug for a role key. Mirrors al/users.ts slugging. */
export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
}

/** Parse a role file's raw content into an AgentRole (key supplied by caller). */
export function parseRole(key: string, content: string): AgentRole {
  const m = content.match(FRONTMATTER_RE)
  const fmText = m ? m[1]! : ''
  const body = m ? (m[2] ?? '') : content
  let fm: Record<string, unknown> = {}
  if (fmText.trim()) {
    try { fm = (parseYaml(fmText) as Record<string, unknown>) ?? {} } catch { fm = {} }
  }
  const asStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const goalsRaw = fm.goals
  const goals = Array.isArray(goalsRaw)
    ? goalsRaw.map((g) => String(g).trim()).filter(Boolean)
    : (typeof goalsRaw === 'string' && goalsRaw.trim() ? [goalsRaw.trim()] : [])
  return {
    key,
    title: asStr(fm.title) ?? key,
    manager: asStr(fm.manager),
    goals,
    cwd: asStr(fm.cwd),
    created: asStr(fm.created),
    charter: body.trim(),
    hasFile: true,
    folder: fm.folder === true || fm.folder === 'true',
    fork: fm.fork === true || fm.fork === 'true',
  }
}

/**
 * Derive the org-chart tree from `manager` edges. Pure + defensive:
 *  - a `manager` pointing at a missing key → role surfaced as a root,
 *    annotated `danglingManager` (never dropped).
 *  - cycles (A→B→A) → broken with a visited-set; the survivor is promoted to a
 *    root annotated `cycleBroken` (never recurses unbounded).
 * Children are sorted by title for stable output.
 */
export function buildOrgTree(roles: AgentRole[]): OrgNode[] {
  const byKey = new Map(roles.map((r) => [r.key, r]))
  const resolvedParent = (r: AgentRole): string | null =>
    r.manager && byKey.has(r.manager) ? r.manager : null
  const childrenOf = new Map<string, AgentRole[]>()
  const roots: AgentRole[] = []
  for (const r of roles) {
    const p = resolvedParent(r)
    if (p === null) roots.push(r)
    else {
      const arr = childrenOf.get(p) ?? []
      arr.push(r)
      childrenOf.set(p, arr)
    }
  }
  const byTitle = (a: AgentRole, b: AgentRole) => a.title.localeCompare(b.title)
  const visited = new Set<string>()
  const build = (r: AgentRole, cycleBroken = false): OrgNode => {
    visited.add(r.key)
    const node: OrgNode = { role: r, children: [] }
    if (r.manager && !byKey.has(r.manager)) node.danglingManager = r.manager
    if (cycleBroken) node.cycleBroken = true
    for (const c of (childrenOf.get(r.key) ?? []).sort(byTitle)) {
      if (visited.has(c.key)) continue // break a cycle
      node.children.push(build(c))
    }
    return node
  }
  const out = roots.sort(byTitle).map((r) => build(r))
  // Any role unreachable from a real root is in a cycle — promote it.
  for (const r of [...roles].sort(byTitle)) {
    if (!visited.has(r.key)) out.push(build(r, true))
  }
  return out
}

export class AgentRegistry {
  private roles = new Map<string, AgentRole>()

  constructor(
    private dir: string,
    private log: (m: string) => void = () => {},
  ) {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* best effort */ }
    this.load()
  }

  private filePath(key: string): string {
    return join(this.dir, `${key}.md`)
  }

  /** Full boot scan — read every agents/*.md. */
  load(): void {
    this.roles.clear()
    let files: string[] = []
    try { files = readdirSync(this.dir) } catch { return }
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const key = file.replace(/\.md$/, '')
      try {
        this.roles.set(key, parseRole(key, readFileSync(join(this.dir, file), 'utf-8')))
      } catch (e) {
        this.log(`[agents] failed to parse ${file}: ${(e as Error).message}`)
      }
    }
  }

  /** Re-read a single role file into memory (or drop it if gone). Returns true on change. */
  private reloadOne(key: string): boolean {
    const prev = this.roles.get(key)
    const path = this.filePath(key)
    let next: AgentRole | undefined
    if (existsSync(path)) {
      try { next = parseRole(key, readFileSync(path, 'utf-8')) } catch { next = prev }
    }
    if (JSON.stringify(prev) === JSON.stringify(next)) return false
    if (next) this.roles.set(key, next)
    else this.roles.delete(key)
    return true
  }

  get(key: string): AgentRole | undefined { return this.roles.get(key) }
  has(key: string): boolean { return this.roles.has(key) }
  list(): AgentRole[] { return [...this.roles.values()] }
  tree(): OrgNode[] { return buildOrgTree(this.list()) }

  /** Body to inject as the system prompt on a fresh spawn (null if no role/empty
   *  or a folder — folders never spawn). */
  resolveCharter(key: string): string | null {
    const role = this.roles.get(key)
    if (!role || role.folder) return null
    return role.charter && role.charter.trim() ? role.charter : null
  }

  /** Mint a unique, immutable key from a display title (collision-suffixed). */
  mintKey(title: string): string {
    const base = slugify(title)
    if (!this.roles.has(base) && !existsSync(this.filePath(base))) return base
    let n = 1
    while (this.roles.has(`${base}-${n}`) || existsSync(this.filePath(`${base}-${n}`))) n++
    return `${base}-${n}`
  }

  /** Create a role (or folder) file. No-op if one already exists (idempotent). */
  create(key: string, init: { title: string; manager?: string | null; charter?: string; cwd?: string | null; goals?: string[]; created?: string; folder?: boolean; fork?: boolean }): AgentRole {
    const existing = this.roles.get(key)
    if (existing || existsSync(this.filePath(key))) {
      this.reloadOne(key)
      return this.roles.get(key)!
    }
    const fm: string[] = [`title: ${init.title}`]
    if (init.manager) fm.push(`manager: ${init.manager}`)
    if (init.folder) fm.push('folder: true')
    if (init.fork) fm.push('fork: true')
    if (init.goals && init.goals.length) {
      fm.push('goals:')
      for (const g of init.goals) fm.push(`  - ${g}`)
    }
    if (init.cwd) fm.push(`cwd: ${init.cwd}`)
    fm.push(`created: ${init.created ?? new Date().toISOString()}`)
    // Folders are org-only — no charter/Memory body.
    const content = init.folder
      ? `---\n${fm.join('\n')}\n---\n`
      : `---\n${fm.join('\n')}\n---\n\n${(init.charter ?? '').trim()}\n\n## Memory\n_(Durable notes the agent maintains across sessions.)_\n`
    this.atomicWrite(key, content)
    const role = parseRole(key, content)
    this.roles.set(key, role)
    return role
  }

  /** Rename a node (surgical `title:` stamp; body untouched). Mainly for folders
   *  — agents own their own title, but a single-line stamp is safe either way. */
  setTitle(key: string, title: string): AgentRole | undefined {
    const path = this.filePath(key)
    if (!existsSync(path)) return undefined
    const content = readFileSync(path, 'utf-8')
    const m = content.match(/^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/)
    if (!m) return undefined
    const lines = m[1]!.split('\n')
    const rest = m[2] ?? ''
    const idx = lines.findIndex((l) => /^title:\s*/.test(l))
    if (idx >= 0) lines[idx] = `title: ${title}`
    else lines.unshift(`title: ${title}`)
    this.atomicWrite(key, `---\n${lines.join('\n')}\n---${rest}`)
    this.reloadOne(key)
    return this.roles.get(key)
  }

  /**
   * Reparent (or root, with manager=null). SURGICAL single-line edit — replaces
   * only the `manager:` line (or inserts after `title:` / removes it), leaving the
   * body and every other frontmatter line byte-identical. Never a yaml round-trip.
   */
  /** Stamp `fork: true` into a role's frontmatter (surgical, body untouched).
   *  Used to retroactively mark legacy fork roles so they get reaped on end. */
  setForkFlag(key: string): AgentRole | undefined {
    const path = this.filePath(key)
    if (!existsSync(path)) return undefined
    const content = readFileSync(path, 'utf-8')
    const m = content.match(/^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/)
    if (!m) return undefined
    const lines = m[1]!.split('\n')
    const rest = m[2] ?? ''
    if (!lines.some((l) => /^fork:\s*/.test(l))) {
      const ti = lines.findIndex((l) => /^title:\s*/.test(l))
      lines.splice(ti >= 0 ? ti + 1 : 0, 0, 'fork: true')
    }
    this.atomicWrite(key, `---\n${lines.join('\n')}\n---${rest}`)
    this.reloadOne(key)
    return this.roles.get(key)
  }

  setManager(key: string, manager: string | null): AgentRole | undefined {
    const path = this.filePath(key)
    if (!existsSync(path)) return undefined
    const content = readFileSync(path, 'utf-8')
    // Capture the body (everything after the closing `---`) byte-for-byte,
    // including its leading newline(s), so only the frontmatter is ever touched.
    const m = content.match(/^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/)
    if (!m) return undefined
    const lines = m[1]!.split('\n')
    const rest = m[2] ?? ''
    const idx = lines.findIndex((l) => /^manager:\s*/.test(l))
    if (manager) {
      if (idx >= 0) lines[idx] = `manager: ${manager}`
      else {
        const ti = lines.findIndex((l) => /^title:\s*/.test(l))
        lines.splice(ti >= 0 ? ti + 1 : 0, 0, `manager: ${manager}`)
      }
    } else if (idx >= 0) {
      lines.splice(idx, 1) // reparent to root → drop the line
    }
    const next = `---\n${lines.join('\n')}\n---${rest}`
    this.atomicWrite(key, next)
    this.reloadOne(key)
    return this.roles.get(key)
  }

  /** Delete a role file + drop from memory. */
  delete(key: string): boolean {
    const path = this.filePath(key)
    try { if (existsSync(path)) unlinkSync(path) } catch (e) {
      this.log(`[agents] delete failed for ${key}: ${(e as Error).message}`)
    }
    return this.roles.delete(key)
  }

  /**
   * Watch the dir for EXTERNAL edits (an agent editing its own file). Content-
   * compared so the hub's own setManager/create writes don't re-fire (the
   * in-memory copy already matches → reloadOne returns false). Debounced ~200ms.
   */
  watch(onChange: (key: string) => void): void {
    const pending = new Map<string, ReturnType<typeof setTimeout>>()
    try {
      watch(this.dir, { persistent: false }, (_evt, filename) => {
        if (!filename || !filename.toString().endsWith('.md')) return
        const key = filename.toString().replace(/\.md$/, '')
        const existing = pending.get(key)
        if (existing) clearTimeout(existing)
        pending.set(key, setTimeout(() => {
          pending.delete(key)
          if (this.reloadOne(key)) onChange(key)
        }, 200))
      })
    } catch (e) {
      this.log(`[agents] watch failed: ${(e as Error).message}`)
    }
  }

  private atomicWrite(key: string, content: string): void {
    const path = this.filePath(key)
    const tmp = path + '.tmp'
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  }
}
