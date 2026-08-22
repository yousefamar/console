// Obsidian-Kanban-format board parser — pure, no I/O.
//
// The board file IS the source of truth for project tasks (no parallel JSON
// store): humans edit it in Obsidian/Console, agents edit it with plain
// file tools, and the hub watches it to trigger delegation. So this module
// must be LOSSLESS: parse→serialize is identity on any file the Obsidian
// Kanban plugin writes, including its quirks — blank lines inside the
// frontmatter fence, blank lines between cards, the trailing
// `%% kanban:settings` block, strikethrough text, indented continuation
// lines under a card.
//
// Card grammar (extensions are TRAILING tokens so the plugin renders them
// as harmless text / real tags):
//   - [ ] Card text #blocked @agentkey ^blockid
// `@agentkey` assigns the card to an agent role (same charset as agent keys);
// `^blockid` is Obsidian block-ref syntax — Console stamps one only when it
// dispatches the card, so hand-written cards never need one and a retitled
// dispatched card keeps its identity. `#blocked` marks a stuck card as a
// PROPERTY (it keeps its column/queue position) instead of a Blocked column.

export interface BoardCard {
  /** Card text with trailing @key/^id/#blocked tokens stripped. */
  text: string
  checked: boolean
  agentKey: string | null
  blockId: string | null
  /** `#blocked` tag present — stuck, waiting on input; stays in its column. */
  blocked: boolean
  /** `#nofork` tag present — dispatch wakes the role DIRECTLY instead of
   *  forking it (trivial cards skip the fork+worktree+merge ceremony). */
  nofork: boolean
  /** `#model/<alias-or-id>` tag — the ticket-fork spawns pinned to this model
   *  (e.g. `#model/haiku` for a fast fix). Aliases stay portable across
   *  backends (they resolve via the ANTHROPIC_DEFAULT_*_MODEL env). */
  model: string | null
  /** Original lines, verbatim — first line + any indented continuations. */
  lines: string[]
}

export interface BoardColumn {
  title: string
  cards: BoardCard[]
  /** Verbatim heading line (`## Title`). */
  headingLine: string
  /** Non-card lines inside the column (blank separators, prose), in order,
   *  keyed by the card index they follow (-1 = before the first card). */
  interstitials: Array<{ afterCard: number; line: string }>
}

export interface KanbanBoard {
  /** Lines before the first `## ` heading (frontmatter fence included), verbatim. */
  header: string[]
  columns: BoardColumn[]
  /** Lines from `%% kanban:settings` to EOF, verbatim (empty if absent). */
  footer: string[]
}

const CARD_RE = /^- \[( |x|X)\] (.*)$/
const HEADING_RE = /^## (.+?)\s*$/
const FOOTER_START = '%% kanban:settings'
const CONTINUATION_RE = /^(?: {2,}|\t)\S/

/** True when the file declares itself an Obsidian Kanban board. */
export function isKanbanBoard(content: string): boolean {
  const fence = content.match(/^---\n([\s\S]*?)\n---/)
  return /^kanban-plugin:/m.test(fence?.[1] ?? '')
}

/** Board-level frontmatter: `deploy_gate: review` means merging to main IS
 *  deploying (auto-deploy-on-main repos), so task work must stay on its
 *  branch until the card owner approves — Under Review gates the merge, not
 *  just the diff. Absent/anything else = fold-into-main as usual. */
export function boardDeployGate(content: string): 'review' | null {
  const fence = content.match(/^---\n([\s\S]*?)\n---/)
  return /^deploy_gate:\s*review\s*$/m.test(fence?.[1] ?? '') ? 'review' : null
}

/** Board-level frontmatter: `default_owner: <agentKey>` — the role that
 *  unassigned cards dragged into In Progress are auto-assigned to. Set once
 *  per project; overrides the "-general" naming-convention resolution. */
export function boardDefaultOwner(content: string): string | null {
  const fence = content.match(/^---\n([\s\S]*?)\n---/)
  const m = (fence?.[1] ?? '').match(/^default_owner:\s*(\S+)\s*$/m)
  return m ? m[1]! : null
}

/** Strip trailing `@key` / `^blockid` / `#blocked` tokens off card text. Order-agnostic. */
export function parseCardTokens(rawText: string): { text: string; agentKey: string | null; blockId: string | null; blocked: boolean; nofork: boolean; model: string | null } {
  let text = rawText.trimEnd()
  let agentKey: string | null = null
  let blockId: string | null = null
  let blocked = false
  let nofork = false
  let model: string | null = null
  // Up to one of each, trailing, any order.
  for (let i = 0; i < 5; i++) {
    const block = text.match(/^(.*?)\s+\^([A-Za-z0-9-]+)$/)
    if (block && blockId === null) {
      text = block[1]!.trimEnd()
      blockId = block[2]!
      continue
    }
    const agent = text.match(/^(.*?)\s+@([a-z0-9][a-z0-9-]*)$/)
    if (agent && agentKey === null) {
      text = agent[1]!.trimEnd()
      agentKey = agent[2]!
      continue
    }
    const blk = text.match(/^(.*?)\s+#blocked$/)
    if (blk && !blocked) {
      text = blk[1]!.trimEnd()
      blocked = true
      continue
    }
    const nf = text.match(/^(.*?)\s+#nofork$/)
    if (nf && !nofork) {
      text = nf[1]!.trimEnd()
      nofork = true
      continue
    }
    const mdl = text.match(/^(.*?)\s+#model\/([\w.:-]+)$/)
    if (mdl && model === null) {
      text = mdl[1]!.trimEnd()
      model = mdl[2]!
      continue
    }
    break
  }
  return { text, agentKey, blockId, blocked, nofork, model }
}

/** Trailing `#tag` run on a card's (token-stripped) text — display-layer
 *  split so the UI can render them as badges. `#blocked` never appears here
 *  (parseCardTokens strips it into `blocked` first); mid-text hashtags stay
 *  in the text (they read as prose, not labels). */
export function splitTrailingTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = []
  let t = text.trimEnd()
  for (;;) {
    const m = t.match(/^(.*?)\s+#([A-Za-z0-9][\w/-]*)$/)
    if (!m) break
    t = m[1]!.trimEnd()
    tags.unshift(m[2]!)
  }
  return { text: t, tags }
}

export function parseBoard(content: string): KanbanBoard {
  const lines = content.split('\n')
  const header: string[] = []
  const columns: BoardColumn[] = []
  const footer: string[] = []

  let i = 0
  // Header: everything before the first `## ` (the frontmatter fence can
  // contain blank lines, so no special-casing — headings can't appear
  // inside it in files the plugin writes).
  while (i < lines.length && !HEADING_RE.test(lines[i]!) && !lines[i]!.startsWith(FOOTER_START)) {
    header.push(lines[i]!)
    i++
  }

  let col: BoardColumn | null = null
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith(FOOTER_START)) {
      footer.push(...lines.slice(i))
      break
    }
    const heading = line.match(HEADING_RE)
    if (heading) {
      col = { title: heading[1]!, cards: [], headingLine: line, interstitials: [] }
      columns.push(col)
      continue
    }
    if (!col) { header.push(line); continue }
    const card = line.match(CARD_RE)
    if (card) {
      const { text, agentKey, blockId, blocked, nofork, model } = parseCardTokens(card[2]!)
      col.cards.push({ text, checked: card[1] !== ' ', agentKey, blockId, blocked, nofork, model, lines: [line] })
      continue
    }
    // Indented continuation attaches to the previous card.
    const last = col.cards[col.cards.length - 1]
    if (last && CONTINUATION_RE.test(line)) {
      last.lines.push(line)
      continue
    }
    col.interstitials.push({ afterCard: col.cards.length - 1, line })
  }

  return { header, columns, footer }
}

export function serializeBoard(board: KanbanBoard): string {
  const out: string[] = [...board.header]
  for (const col of board.columns) {
    out.push(col.headingLine)
    const before = col.interstitials.filter((x) => x.afterCard === -1).map((x) => x.line)
    out.push(...before)
    col.cards.forEach((card, idx) => {
      out.push(...card.lines)
      out.push(...col.interstitials.filter((x) => x.afterCard === idx).map((x) => x.line))
    })
  }
  out.push(...board.footer)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Mutations — all rewrite the card's first line from its parsed fields, so a
// mutated card loses nothing but gains/updates trailing tokens. Continuation
// lines ride along untouched.
// ---------------------------------------------------------------------------

/** Neutralize a token collision in card TEXT: prose whose tail matches the
 *  trailing-token grammar (`#blocked`, `@key`, `^id`) would be stripped into
 *  tokens on the next parse — truncating the text and flipping card state
 *  (live bug: a card titled "… UI like #blocked" came back blocked with a
 *  cut title). Wrap the colliding tail in backticks: renders as a code span
 *  in Obsidian, reads as the literal the author meant, and no longer matches
 *  (the token regexes require the bare word at end-of-line). Applied at the
 *  refreshCardLine choke point, so every writer (add/edit/assign/block) is
 *  covered; parse-only paths never mutate text. */
export function sanitizeCardText(text: string): string {
  let t = text
  // Repeat: "foo @a #blocked" collides twice.
  for (;;) {
    const m = t.match(/(\s)(#blocked|#nofork|#model\/[\w.:-]+|@[a-z0-9][a-z0-9-]*|\^[A-Za-z0-9-]+)$/)
    if (!m) return t
    t = `${t.slice(0, m.index! + m[1]!.length)}\`${m[2]!}\``
  }
}

function cardFirstLine(card: BoardCard): string {
  card.text = sanitizeCardText(card.text)
  const tokens = [card.text]
  if (card.model) tokens.push(`#model/${card.model}`)
  if (card.nofork) tokens.push('#nofork')
  if (card.blocked) tokens.push('#blocked')
  if (card.agentKey) tokens.push(`@${card.agentKey}`)
  if (card.blockId) tokens.push(`^${card.blockId}`)
  return `- [${card.checked ? 'x' : ' '}] ${tokens.join(' ')}`
}

/** Re-render a card's first line after mutating text/checked/agentKey/blockId. */
export function refreshCardLine(card: BoardCard): void {
  card.lines[0] = cardFirstLine(card)
}


/** Image attachments on a card: detail lines that are markdown images
 *  (`![alt](path)`). Paths are relative to the vault's sibling assets dir
 *  (the pasteImage convention) — served at /notes/asset/<path>. */
/** Every http(s) URL on a card (text + detail lines), for click-from-the-tile
 *  affordances. Markdown links yield their label; bare URLs label as their
 *  hostname. Image lines are EXCLUDED — they render as thumbnails already. */
export function cardUrls(card: BoardCard): Array<{ url: string; label: string }> {
  const out: Array<{ url: string; label: string }> = []
  const seen = new Set<string>()
  const push = (url: string, label: string) => {
    // Trailing punctuation clings to bare URLs in prose ("see https://x.com.").
    const clean = url.replace(/[.,;:!?)\]}>'"]+$/, '')
    if (seen.has(clean)) return
    seen.add(clean)
    out.push({ url: clean, label })
  }
  for (const line of card.lines) {
    if (/!\[[^\]]*\]\(/.test(line)) continue // image line — thumbnail territory
    // Markdown links first (label wins over hostname)…
    const mdRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
    let consumed = line
    for (let m = mdRe.exec(line); m; m = mdRe.exec(line)) {
      push(m[2]!, m[1]!)
      consumed = consumed.replace(m[0], ' ')
    }
    // …then bare URLs not inside a markdown link.
    const bareRe = /https?:\/\/[^\s)\]}>"']+/g
    for (let m = bareRe.exec(consumed); m; m = bareRe.exec(consumed)) {
      let label = m[0]!
      try { label = new URL(m[0]!).hostname.replace(/^www\./, '') } catch { /* keep raw */ }
      push(m[0]!, label)
    }
  }
  return out
}

export function cardImagePaths(card: BoardCard): string[] {
  const out: string[] = []
  for (const line of card.lines.slice(1)) {
    const m = line.trim().match(/^!\[[^\]]*\]\(([^)]+)\)$/)
    if (m) out.push(m[1]!)
  }
  return out
}

export interface CardRef {
  column: string
  /** Index within the column. */
  index: number
}

export function findCard(board: KanbanBoard, pred: (card: BoardCard) => boolean): CardRef | null {
  for (const col of board.columns) {
    const index = col.cards.findIndex(pred)
    if (index !== -1) return { column: col.title, index }
  }
  return null
}

export function findCardByBlockId(board: KanbanBoard, blockId: string): CardRef | null {
  return findCard(board, (c) => c.blockId === blockId)
}

export function getCard(board: KanbanBoard, ref: CardRef): BoardCard | null {
  const col = board.columns.find((c) => c.title === ref.column)
  return col?.cards[ref.index] ?? null
}

/** Move a card to the end of another column. Checked state follows the
 *  destination when it's a done-column ("Done"/"Complete" naming). */
export function moveCard(board: KanbanBoard, ref: CardRef, toColumn: string): boolean {
  const from = board.columns.find((c) => c.title === ref.column)
  const to = board.columns.find((c) => c.title === toColumn)
  const card = from?.cards[ref.index]
  if (!from || !to || !card) return false
  from.cards.splice(ref.index, 1)
  // Interstitials that pointed past the removed card shift down one.
  for (const x of from.interstitials) {
    if (x.afterCard >= ref.index) x.afterCard = Math.max(-1, x.afterCard - 1)
  }
  to.cards.push(card)
  const isDone = /^(done|complete|completed|shipped)$/i.test(toColumn)
  if (card.checked !== isDone) {
    card.checked = isDone
    refreshCardLine(card)
  }
  return true
}

export function addCard(board: KanbanBoard, columnTitle: string, text: string, opts?: { agentKey?: string; blockId?: string; position?: 'top' | 'bottom' }): BoardCard | null {
  const col = board.columns.find((c) => c.title === columnTitle)
  if (!col) return null
  const card: BoardCard = {
    text,
    checked: false,
    agentKey: opts?.agentKey ?? null,
    blockId: opts?.blockId ?? null,
    blocked: false,
    nofork: false,
    model: null,
    lines: [''],
  }
  refreshCardLine(card)
  if (opts?.position === 'top') {
    col.cards.unshift(card)
    // Interstitials are keyed by the card index they follow — everything
    // shifts down one, EXCEPT pre-first-card lines (-1): those are the
    // blank separator under the heading, which must stay above the new top.
    for (const x of col.interstitials) {
      if (x.afterCard >= 0) x.afterCard += 1
    }
  } else {
    col.cards.push(card)
  }
  return card
}
