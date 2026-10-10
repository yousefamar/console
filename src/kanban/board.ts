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
  /** `#nofork` tag present — dispatch wakes the role DIRECTLY instead of
   *  forking it (trivial cards skip the fork+worktree+merge ceremony). */
  nofork: boolean
  /** `#inherit` tag present — the ticket-fork inherits the parent's whole
   *  transcript (default is a fresh-context fork + digest; ^tall-colt). */
  inherit: boolean
  /** `#forge` / `#local` tag — WHERE this card's fork runs. `#local` opts one
   *  card out of a board that set `remote: forge`; `#forge` opts one in. null
   *  = follow the board. */
  remote: 'forge' | 'local' | null
  /** `#model/<alias-or-id>` tag, or the bare alias shorthand `#sonnet` /
   *  `#opus` / `#haiku` / `#fable` — the ticket-fork spawns pinned to this
   *  model (e.g. `#haiku` for a fast fix). */
  model: string | null
  /** `#effort/<level>` tag — the ticket-fork spawns pinned to this `--effort`
   *  (`low|medium|high|xhigh|max`) instead of the policy's fork level. */
  effort: string | null
  /** Key-value metadata: trailing `#key/value` tags (`#created-by/ui`,
   *  `#requested-by/essam`), in line order. `#key:value` is accepted on read
   *  and written back as `/`. Every card the hub creates carries `created-by`
   *  (addCard refuses without one); any other key is optional and free-form. */
  meta: Record<string, string>
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

/** Columns the hub dispatches from — mirror of the server's
 *  DISPATCH_COLUMN_RE (kanban/dispatch.ts). Keep the two in sync. */
export const DISPATCH_COLUMN_RE = /^(in.?progress|doing|active|now)$/i

/** Mirror of the server's DONE_COLUMN_RE (kanban/dispatch.ts). */
export const DONE_COLUMN_RE = /^(done|complete|completed|shipped)$/i

const CARD_RE = /^- \[( |x|X)\] (.*)$/
const HEADING_RE = /^## (.+?)\s*$/
const FOOTER_START = '%% kanban:settings'
const CONTINUATION_RE = /^(?: {2,}|\t)\S/

/** True when the file declares itself an Obsidian Kanban board. */
export function isKanbanBoard(content: string): boolean {
  const fence = content.match(/^---\n([\s\S]*?)\n---/)
  return /^kanban-plugin:/m.test(fence?.[1] ?? '')
}

/** Board-level frontmatter: `default_owner: <agentKey>` — the role that
 *  unassigned cards dragged into In Progress are auto-assigned to, and the
 *  agent a project opens on by default. */
export function boardDefaultOwner(content: string): string | null {
  const fence = content.match(/^---\n([\s\S]*?)\n---/)
  const m = (fence?.[1] ?? '').match(/^default_owner:\s*(\S+)\s*$/m)
  return m ? m[1]! : null
}

/** Board-level frontmatter: `remote: forge` — every ticket-fork on this board
 *  runs on the remote box unless its card says `#local`. Keep in sync with
 *  server/src/forge/config.ts (anything but a known target reads as unset). */
export function boardRemote(content: string): 'forge' | 'local' | null {
  const fence = content.match(/^---\n([\s\S]*?)\n---/)
  const m = (fence?.[1] ?? '').match(/^remote:\s*(\S+)\s*$/m)
  return m?.[1] === 'forge' ? 'forge' : m?.[1] === 'local' ? 'local' : null
}

/** The CLI's model aliases (`ANTHROPIC_DEFAULT_<ALIAS>_MODEL`) — keep in sync
 *  with server/src/kanban/board.ts. A bare `#<alias>` card tag is shorthand
 *  for `#model/<alias>`; other hashtags never pin a model. */
export const MODEL_ALIASES = ['opus', 'fable', 'sonnet', 'haiku'] as const
export function isModelAlias(s: string): s is (typeof MODEL_ALIASES)[number] {
  return (MODEL_ALIASES as readonly string[]).includes(s)
}
const MODEL_ALIAS_RE = new RegExp(`^(.*?)\\s+#(${MODEL_ALIASES.join('|')})$`)
/** Serialized model pin: aliases as the bare shorthand, ids behind `#model/`. */
export function modelToken(model: string): string {
  return isModelAlias(model) ? `#${model}` : `#model/${model}`
}
/** The CLI's `--effort` levels — keep in sync with server/src/kanban/board.ts. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const EFFORT_RE = new RegExp(`^(.*?)\\s+#effort[/:](${EFFORT_LEVELS.join('|')})$`)

/** The one metadata key every created card must carry. */
export const CREATED_BY = 'created-by'

/** Keys the dispatch grammar already owns — never metadata. */
const RESERVED_META_KEYS = ['model', 'effort']
const META_RE = /^(.*?)\s+#([a-z][a-z0-9-]*)[/:]([A-Za-z0-9][\w.-]*)$/
const META_TAG_RE = /^([a-z][a-z0-9-]*)[/:]([A-Za-z0-9][\w.-]*)$/

/** A bare tag (`created-by/ui`, no `#`) as a metadata pair, or null when it is
 *  an ordinary tag. */
export function tagAsMeta(tag: string): { key: string; value: string } | null {
  const m = tag.match(META_TAG_RE)
  return m && !RESERVED_META_KEYS.includes(m[1]!) ? { key: m[1]!, value: m[2]! } : null
}

/** Normalise a metadata key as typed (`Requested By` → `requested-by`); throws
 *  on one the tag grammar cannot carry. */
export function metaKey(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`"${raw}" is not a usable tag key (letters, digits and dashes, starting with a letter)`)
  if (RESERVED_META_KEYS.includes(key)) throw new Error(`"${key}" is a dispatch tag, not metadata`)
  return key
}

/** Normalise a metadata value into one tag-safe word (`Essam K.` → `Essam-K.`);
 *  throws when nothing usable is left. */
export function metaValue(raw: string): string {
  const value = raw.trim().replace(/\s+/g, '-').replace(/[^\w.-]/g, '').replace(/^[^A-Za-z0-9]+/, '')
  if (!value) throw new Error(`"${raw}" is not a usable tag value`)
  return value
}

/** Peel a trailing run of metadata tags off text someone typed. */
export function splitTrailingMeta(text: string): { text: string; meta: Record<string, string> } {
  const pairs: Array<[string, string]> = []
  let t = text.trimEnd()
  for (;;) {
    const m = t.match(META_RE)
    if (!m || RESERVED_META_KEYS.includes(m[2]!) || pairs.some(([k]) => k === m[2])) break
    t = m[1]!.trimEnd()
    pairs.push([m[2]!, m[3]!])
  }
  return { text: pairs.length ? t : text, meta: Object.fromEntries(pairs.reverse()) }
}

/** Display values for the creators the hub itself stamps. */
const CREATOR_LABELS: Record<string, string> = { ui: 'UI', cli: 'CLI', ring: 'Ring', android: 'Android', listener: 'Listener', property: 'Property' }

/** `created-by` → "Created by"; `ui` → "UI". Any other value reads as written. */
export function metaLabel(key: string, value: string): { key: string; value: string } {
  const words = key.replace(/-/g, ' ')
  return {
    key: words.charAt(0).toUpperCase() + words.slice(1),
    value: key === CREATED_BY ? CREATOR_LABELS[value] ?? value : value,
  }
}

/** Strip trailing `@key` / `^blockid` / `#blocked` / `#key/value` tokens off card text. Order-agnostic. */
export function parseCardTokens(rawText: string): { text: string; agentKey: string | null; blockId: string | null; blocked: boolean; nofork: boolean; inherit: boolean; remote: 'forge' | 'local' | null; model: string | null; effort: string | null; meta: Record<string, string> } {
  let text = rawText.trimEnd()
  let agentKey: string | null = null
  let blockId: string | null = null
  let blocked = false
  let nofork = false
  let inherit = false
  let remote: 'forge' | 'local' | null = null
  let model: string | null = null
  let effort: string | null = null
  // Read right to left, so collected in reverse line order.
  const pairs: Array<[string, string]> = []
  // Up to one of each (and one per metadata key), trailing, any order.
  for (let i = 0; i < 32; i++) {
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
    const inh = text.match(/^(.*?)\s+#inherit$/)
    if (inh && !inherit) {
      text = inh[1]!.trimEnd()
      inherit = true
      continue
    }
    const rem = text.match(/^(.*?)\s+#(forge|local)$/)
    if (rem && remote === null) {
      text = rem[1]!.trimEnd()
      remote = rem[2]! as 'forge' | 'local'
      continue
    }
    const mdl = text.match(/^(.*?)\s+#model\/([\w.:-]+)$/) ?? text.match(MODEL_ALIAS_RE)
    if (mdl && model === null) {
      text = mdl[1]!.trimEnd()
      model = mdl[2]!
      continue
    }
    const eff = text.match(EFFORT_RE)
    if (eff && effort === null) {
      text = eff[1]!.trimEnd()
      effort = eff[2]!
      continue
    }
    const kv = text.match(META_RE)
    if (kv && !RESERVED_META_KEYS.includes(kv[2]!) && !pairs.some(([k]) => k === kv[2])) {
      text = kv[1]!.trimEnd()
      pairs.push([kv[2]!, kv[3]!])
      continue
    }
    break
  }
  const meta = Object.fromEntries(pairs.reverse())
  return { text, agentKey, blockId, blocked, nofork, inherit, remote, model, effort, meta }
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

/** What a card shows: its prose, plain tag badges, and labelled metadata
 *  ("Created by" / "UI"). A metadata tag stranded left of a plain tag
 *  (`#created-by/ui #bi`) is still metadata here. */
export function cardDisplay(card: Pick<BoardCard, 'text' | 'meta'>): { text: string; tags: string[]; meta: Array<{ key: string; value: string }> } {
  const split = splitTrailingTags(card.text)
  const pairs: Record<string, string> = { ...card.meta }
  const tags: string[] = []
  for (const t of split.tags) {
    const kv = tagAsMeta(t)
    if (kv) pairs[kv.key] ??= kv.value
    else tags.push(t)
  }
  return { text: split.text, tags, meta: Object.entries(pairs).map(([k, v]) => metaLabel(k, v)) }
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
  // A bare unindented line directly under a card's own lines is an orphaned
  // detail line (server parser twin, ^loud-pony); a blank line ends the run.
  let inCard = false
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
      inCard = false
      continue
    }
    if (!col) { header.push(line); continue }
    const card = line.match(CARD_RE)
    if (card) {
      const { text, agentKey, blockId, blocked, nofork, inherit, remote, model, effort, meta } = parseCardTokens(card[2]!)
      col.cards.push({ text, checked: card[1] !== ' ', agentKey, blockId, blocked, nofork, inherit, remote, model, effort, meta, lines: [line] })
      inCard = true
      continue
    }
    // Indented continuation attaches to the previous card.
    const last = col.cards[col.cards.length - 1]
    if (last && (CONTINUATION_RE.test(line) || (inCard && line.trim() !== ''))) {
      last.lines.push(line)
      continue
    }
    col.interstitials.push({ afterCard: col.cards.length - 1, line })
    inCard = false
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
    const m = t.match(new RegExp(`(\\s)(#blocked|#nofork|#inherit|#forge|#local|#model\\/[\\w.:-]+|#(?:${MODEL_ALIASES.join('|')})|#effort[/:](?:${EFFORT_LEVELS.join('|')})|@[a-z0-9][a-z0-9-]*|\\^[A-Za-z0-9-]+)$`))
    if (!m) return t
    t = `${t.slice(0, m.index! + m[1]!.length)}\`${m[2]!}\``
  }
}

function cardFirstLine(card: BoardCard): string {
  // Metadata tags typed at the end of the text (an edit, a quick-add) join the
  // card's metadata; the creator is never overwritten that way.
  const typed = splitTrailingMeta(card.text)
  for (const [k, v] of Object.entries(typed.meta)) if (!(k === CREATED_BY && card.meta[k])) card.meta[k] = v
  card.text = sanitizeCardText(typed.text)
  const tokens = [card.text]
  for (const [k, v] of Object.entries(card.meta)) tokens.push(`#${k}/${v}`)
  if (card.model) tokens.push(modelToken(card.model))
  if (card.effort) tokens.push(`#effort/${card.effort}`)
  if (card.remote) tokens.push(`#${card.remote}`)
  if (card.nofork) tokens.push('#nofork')
  if (card.inherit) tokens.push('#inherit')
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

/** Media attachments on a card are detail lines that are EXACTLY a markdown
 *  image (`![alt](path)`), path relative to the vault's sibling assets dir —
 *  served at /notes/asset/<path>. Video clips (webm/mp4) share the line shape;
 *  the extension tells them apart. */
export const VIDEO_ASSET_RE = /\.(webm|mp4)$/i

export function isVideoAsset(path: string): boolean {
  return VIDEO_ASSET_RE.test(path)
}

export function cardMediaPaths(card: Pick<BoardCard, 'lines'>): string[] {
  const out: string[] = []
  for (const line of card.lines.slice(1)) {
    const m = line.trim().match(/^!\[[^\]]*\]\(([^)]+)\)$/)
    if (m) out.push(m[1]!)
  }
  return out
}

/** Still images only. */
export function cardImagePaths(card: Pick<BoardCard, 'lines'>): string[] {
  return cardMediaPaths(card).filter((p) => !isVideoAsset(p))
}

export function cardVideoPaths(card: Pick<BoardCard, 'lines'>): string[] {
  return cardMediaPaths(card).filter(isVideoAsset)
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

/** Resolve a `/board/*`-style card query — an id (caret optional) when
 *  stamped, else the exact card text. Narrower than BoardOps on purpose: no
 *  substring matching, so a card quoting another's id can never be the hit
 *  (see the ^glad-wolf note in server/src/kanban/board-ops.ts). */
export function findCardByQuery(board: KanbanBoard, query: string): { ref: CardRef; card: BoardCard } | null {
  const q = query.trim()
  const ref = findCardByBlockId(board, q.replace(/^\^/, '')) ?? (q.startsWith('^') ? null : findCard(board, (c) => c.text === q))
  if (!ref) return null
  const card = getCard(board, ref)
  return card ? { ref, card } : null
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

/** Add a card. `createdBy` is mandatory — who or what made it (`ui`, `ring`,
 *  an agent key); a card cannot be created unattributed. `meta` carries any
 *  further `key → value` tags. Metadata tags typed at the end of `text` are
 *  taken as metadata too. */
export function addCard(board: KanbanBoard, columnTitle: string, text: string, opts: { createdBy: string; meta?: Record<string, string>; agentKey?: string; blockId?: string; position?: 'top' | 'bottom' }): BoardCard | null {
  if (!opts?.createdBy?.trim()) throw new Error('a card needs a creator (created-by)')
  const col = board.columns.find((c) => c.title === columnTitle)
  if (!col) return null
  const typed = splitTrailingMeta(text)
  const meta: Record<string, string> = { [CREATED_BY]: metaValue(opts.createdBy) }
  for (const [k, v] of [...Object.entries(typed.meta), ...Object.entries(opts.meta ?? {})]) {
    const key = metaKey(k)
    if (key !== CREATED_BY) meta[key] = metaValue(v)
  }
  const card: BoardCard = {
    text: typed.text,
    checked: false,
    agentKey: opts.agentKey ?? null,
    blockId: opts.blockId ?? null,
    remote: null,
    blocked: false,
    nofork: false,
    inherit: false,
    model: null,
    effort: null,
    meta,
    lines: [''],
  }
  refreshCardLine(card)
  if (opts.position === 'top') {
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
