// Skill hints for dispatch envelopes — pure logic + one small reader.
//
// Subsystem detail lives in project skills (`.claude/skills/<name>/SKILL.md`,
// see CLAUDE.md → Skills). A `paths:`-scoped skill only enters the CLI's
// skill listing once the session touches a matching file, so a fork that
// starts by READING (or by running the CLI) never sees it. The envelope
// therefore names the skills a card plausibly touches so the fork can `Read`
// the SKILL.md before its first edit.
//
// Matching is deliberately narrow — a wrong hint costs the fork a few
// thousand tokens of the wrong subsystem: (1) a file path in the card text
// that matches one of the skill's `paths` globs; (2) a curated
// `metadata.card_keywords` phrase from the skill's frontmatter, matched as a
// whole word/phrase. Skill NAMES are never matched on their own ("property",
// "ring" and "music" are ordinary English).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SkillHint {
  name: string
  /** Repo-relative path to the SKILL.md. */
  file: string
  paths: string[]
  keywords: string[]
}

/** Parse the frontmatter fields we care about. Hand-rolled on purpose: the
 *  frontmatter is ours, the shapes are flat, and the hub has no YAML dep in
 *  this module's import graph. */
export function parseSkillFrontmatter(text: string): { name?: string; paths: string[]; keywords: string[] } {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return { paths: [], keywords: [] }
  const out: { name?: string; paths: string[]; keywords: string[] } = { paths: [], keywords: [] }
  let inMeta = false
  for (const raw of m[1]!.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const indented = /^\s/.test(line)
    if (!indented) inMeta = false
    const kv = line.trim().match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!kv) continue
    const [, key, value] = kv
    if (!indented && key === 'name') out.name = value!.trim()
    else if (!indented && key === 'paths') out.paths = splitList(value!)
    else if (!indented && key === 'metadata') inMeta = true
    else if (indented && inMeta && key === 'card_keywords') out.keywords = splitList(value!)
  }
  return out
}

function splitList(value: string): string[] {
  const v = value.trim().replace(/^"|"$/g, '')
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Read every `<repoDir>/.claude/skills/<name>/SKILL.md`. Missing dir → []. */
export function loadSkillIndex(repoDir: string): SkillHint[] {
  const dir = join(repoDir, '.claude', 'skills')
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: SkillHint[] = []
  for (const n of names.sort()) {
    const file = join(dir, n, 'SKILL.md')
    try {
      if (!statSync(file).isFile()) continue
      const fm = parseSkillFrontmatter(readFileSync(file, 'utf-8'))
      if (!fm.paths.length && !fm.keywords.length) continue
      out.push({ name: fm.name ?? n, file: `.claude/skills/${n}/SKILL.md`, paths: fm.paths, keywords: fm.keywords })
    } catch { /* unreadable skill — skip */ }
  }
  return out
}

/** Minimal glob → RegExp: `**` spans directories, `*` stays within one. The
 *  glob is anchored to a path START (skills name repo-relative paths) but a
 *  card may quote a deeper suffix, so a match anywhere after a `/` boundary
 *  also counts. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  const g = glob.trim()
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(`(?:^|/)${re}$`)
}

const PATH_TOKEN = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+/g

/** Skills a card plausibly touches, in index order. Pure. */
export function skillsForCard(cardText: string, index: readonly SkillHint[]): SkillHint[] {
  const text = cardText.toLowerCase()
  const pathTokens = (cardText.match(PATH_TOKEN) ?? []).map((t) => t.replace(/[.,;:)]+$/, ''))
  const hits: SkillHint[] = []
  for (const skill of index) {
    let hit = false
    for (const g of skill.paths) {
      const re = globToRegExp(g)
      if (pathTokens.some((t) => re.test(t))) { hit = true; break }
    }
    if (!hit) {
      for (const kw of skill.keywords) {
        const k = kw.toLowerCase()
        if (!k) continue
        const re = new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i')
        if (re.test(text)) { hit = true; break }
      }
    }
    if (hit) hits.push(skill)
  }
  return hits
}

/** The envelope stanza. Empty array → no lines. */
export function skillHintLines(hits: readonly SkillHint[]): string[] {
  if (!hits.length) return []
  const list = hits.map((h) => `\`${h.name}\` → \`${h.file}\``).join('; ')
  return [
    `SKILLS: this card looks like it touches ${list}. \`Read\` that SKILL.md before you start — it holds the subsystem's mechanics and gotchas that CLAUDE.md only summarises (the skill also auto-loads once you edit a matching file, but not before).`,
    '',
  ]
}
