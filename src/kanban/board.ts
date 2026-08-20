// Obsidian-Kanban-format board parser — pure, no I/O. CLIENT PORT of
// server/src/kanban/board.ts (separate builds — keep the two in sync, the
// frontmatter.ts precedent).
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

/** Strip trailing `@key` / `^blockid` / `#blocked` tokens off card text. Order-agnostic. */
export function parseCardTokens(rawText: string): { text: string; agentKey: string | null; blockId: string | null; blocked: boolean } {
  let text = rawText.trimEnd()
  let agentKey: string | null = null
  let blockId: string | null = null
  let blocked = false
  // Up to one of each, trailing, any order.
  for (let i = 0; i < 3; i++) {
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
    break
  }
  return { text, agentKey, blockId, blocked }
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
      const { text, agentKey, blockId, blocked } = parseCardTokens(card[2]!)
      col.cards.push({ text, checked: card[1] !== ' ', agentKey, blockId, blocked, lines: [line] })
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

function cardFirstLine(card: BoardCard): string {
  const tokens = [card.text]
  if (card.blocked) tokens.push('#blocked')
  if (card.agentKey) tokens.push(`@${card.agentKey}`)
  if (card.blockId) tokens.push(`^${card.blockId}`)
  return `- [${card.checked ? 'x' : ' '}] ${tokens.join(' ')}`
}

/** Re-render a card's first line after mutating text/checked/agentKey/blockId. */
export function refreshCardLine(card: BoardCard): void {
  card.lines[0] = cardFirstLine(card)
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
