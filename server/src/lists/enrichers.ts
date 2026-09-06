// List enrichers — the SEPARATE step that acts on a list row after the raw
// row has landed (from the ring, or typed by hand). Each enricher declares the
// columns it owns, what "pending" looks like (an empty column, by Yousef's
// design: "empty means un-added"), and what to do about it: FILL cells
// (movie → year/series) or DRAIN the row (groceries → the open Sainsbury's
// order, then the row leaves the list — it is a queue). Run by the
// ListWatcher (watcher.ts) on any configured list note.

export interface EnricherDeps {
  /** One-shot LLM call on the small/fast model; null on failure. */
  llm: (prompt: string) => Promise<string | null>
  /** Run a CLI (the Sainsbury's one); resolves with stdout even on non-zero exit. */
  exec: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>
  log: (msg: string) => void
}

export type RowResult =
  | { kind: 'fill'; cells: Record<string, string> }
  /** Remove the row; `note` is appended (dated) to `logTo` when given. */
  | { kind: 'remove'; note?: string; logTo?: string }
  /** Still pending — nothing to do yet (no open order) or couldn't act. `retry`
   *  = a genuine failure worth backing off; false = "not yet", check again next sweep. */
  | { kind: 'skip'; retry: boolean; reason?: string }

export interface Enricher {
  /** Columns this enricher owns, in table order (the raw row leaves them blank). */
  columns: string[]
  /** Column the spoken item lands in (default 'Item'). */
  itemColumn?: string
  /** Extra columns the raw row should carry with a default value. */
  defaults?: Record<string, string>
  /** Is this row still waiting? */
  pending: (row: Record<string, string>) => boolean
  /** Act on ALL pending rows of one list in one go (a shared checkout, one
   *  order-status call). Results align with `rows`. */
  run: (rows: Record<string, string>[], deps: EnricherDeps) => Promise<RowResult[]>
}

export const ITEM_COLUMN = 'Item'
export const ADDED_COLUMN = 'Added'

// --------------------------------------------------------------------------
// movie — `| Title | Year | Series | Watched | Added |`; the LLM canonicalises
// the title and fills Year/Series. Pending = a title without a year.
// --------------------------------------------------------------------------

async function identifyMovie(spoken: string, deps: EnricherDeps): Promise<RowResult> {
  const reply = await deps.llm([
    'A user spoke the name of a film or TV series to add to their watch list. Identify it and reply with exactly one JSON object, nothing else:',
    '  {"title":"<canonical title>","year":"<first release year, 4 digits>","series":"No" | "Yes" | "Yes (<network or season note>)"}',
    'If you genuinely cannot identify it, reply {"title":"","year":"","series":""}.',
    '',
    `Spoken: ${JSON.stringify(spoken)}`,
    'JSON:',
  ].join('\n'))
  if (!reply) return { kind: 'skip', retry: true, reason: 'llm unavailable' }
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return { kind: 'skip', retry: true, reason: 'no json' }
  try {
    const o = JSON.parse(m[0]) as { title?: unknown; year?: unknown; series?: unknown }
    const year = typeof o.year === 'string' || typeof o.year === 'number' ? String(o.year).trim() : ''
    if (!/^\d{4}$/.test(year)) return { kind: 'skip', retry: true, reason: 'unidentified' }
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : spoken
    const series = typeof o.series === 'string' && o.series.trim() ? o.series.trim() : 'No'
    return { kind: 'fill', cells: { Title: title, Year: year, Series: series } }
  } catch { return { kind: 'skip', retry: true, reason: 'bad json' } }
}

const movie: Enricher = {
  columns: ['Title', 'Year', 'Series', 'Watched'],
  itemColumn: 'Title',
  defaults: { Watched: 'No' },
  pending: (row) => !!row.title && !row.year,
  run: (rows, deps) => Promise.all(rows.map((r) => identifyMovie(r.title ?? '', deps))),
}

// --------------------------------------------------------------------------
// grocery-order — the groceries list is a QUEUE. When a Sainsbury's order is
// open (placed, before cutoff), every pending item is searched, the best
// product is added to that order in amend mode, ONE checkout confirms the
// amendment, and the rows leave the list (logged to groceries-ordered.md).
// No open order → rows stay until the weekly cron opens one (it then runs
// `con notes enrich`). This enricher NEVER books a slot or places a new
// order — that is the cron's job.
// --------------------------------------------------------------------------

export const GROCERIES_ORDERED_LOG = 'scratch/lists/groceries-ordered.md'
const CHECKOUT_TIMEOUT_MS = 6 * 60_000

interface OrderStatus { active?: boolean; order_uid?: string; order_id?: string; is_cutoff?: boolean; is_in_amend_mode?: boolean; slot_start_time?: string }
interface Product { product_uid: string; name: string; retail_price?: { price?: number } }

function parseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T } catch { return null }
}

/** Pick the product for a spoken item: the LLM chooses among the top hits
 *  (or says none); without an LLM the top hit stands. */
async function pickProduct(spoken: string, products: Product[], deps: EnricherDeps): Promise<Product | null> {
  if (!products.length) return null
  const top = products.slice(0, 6)
  const reply = await deps.llm([
    `A user asked for "${spoken}" on their grocery list. Which of these Sainsbury's products is what they meant? Reply with exactly one JSON object, nothing else: {"index": <0-based index>} or {"index": null} if none fits.`,
    ...top.map((p, i) => `${i}. ${p.name}${p.retail_price?.price != null ? ` (£${p.retail_price.price})` : ''}`),
    'JSON:',
  ].join('\n'))
  if (!reply) return top[0]!
  const m = /\{[\s\S]*\}/.exec(reply)
  const o = m ? parseJson<{ index?: unknown }>(m[0]) : null
  if (!o || o.index === null) return null
  const i = typeof o.index === 'number' ? o.index : Number(o.index)
  return Number.isInteger(i) && top[i] ? top[i]! : top[0]!
}

const groceryOrder: Enricher = {
  columns: [],
  pending: (row) => !!row.item,
  run: async (rows, deps) => {
    const skipAll = (retry: boolean, reason: string): RowResult[] => rows.map(() => ({ kind: 'skip', retry, reason }))
    const status = await deps.exec('sainsburys', ['order', 'status', '--json'])
    const st = parseJson<OrderStatus>(status.stdout)
    if (status.code !== 0 || !st) {
      // Session likely expired — the usuals script logs in each run; do the same once.
      const login = await deps.exec('sainsburys', ['auth', 'login'], { timeoutMs: 120_000 })
      if (login.code !== 0) return skipAll(true, 'sainsburys auth failed')
      const again = await deps.exec('sainsburys', ['order', 'status', '--json'])
      const st2 = parseJson<OrderStatus>(again.stdout)
      if (again.code !== 0 || !st2) return skipAll(true, 'order status failed')
      return groceryOrder.run(rows, { ...deps, exec: deps.exec })
    }
    const orderId = st.order_uid ?? st.order_id
    if (!st.active || !orderId) return skipAll(false, 'no open order')
    if (st.is_cutoff) return skipAll(false, 'open order past cutoff')

    if (!st.is_in_amend_mode) {
      const amend = await deps.exec('sainsburys', ['order', 'amend', orderId])
      if (amend.code !== 0) return skipAll(true, `order amend ${orderId} failed`)
    }

    const results: RowResult[] = []
    const added: Array<{ item: string; product: Product }> = []
    for (const row of rows) {
      const item = row.item ?? ''
      const search = await deps.exec('sainsburys', ['product', 'search', item, '--json'])
      const products = parseJson<{ products?: Product[] }>(search.stdout)?.products ?? []
      const product = await pickProduct(item, products, deps)
      if (!product) { results.push({ kind: 'skip', retry: true, reason: `no product matched "${item}"` }); continue }
      const add = await deps.exec('sainsburys', ['basket', 'add', product.product_uid, '-q', '1', '--slot-booked'])
      if (add.code !== 0) { results.push({ kind: 'skip', retry: true, reason: `basket add failed for "${item}"` }); continue }
      added.push({ item, product })
      results.push({ kind: 'remove', note: `${item} → ${product.name} (order ${orderId})`, logTo: GROCERIES_ORDERED_LOG })
    }
    if (!added.length) return results

    // One checkout confirms the whole amendment. If it fails, nothing leaves
    // the list — the items are in the basket but the amend isn't committed.
    const checkout = await deps.exec('sainsburys', ['checkout', '--yes', '--headless', '--slot-booked'], { timeoutMs: CHECKOUT_TIMEOUT_MS })
    if (checkout.code !== 0) {
      deps.log(`[lists/grocery-order] checkout failed for order ${orderId}: ${(checkout.stderr || checkout.stdout).slice(-300)}`)
      return results.map((r) => (r.kind === 'remove' ? { kind: 'skip', retry: true, reason: 'checkout failed (items sit in the basket, amend not confirmed)' } : r))
    }
    deps.log(`[lists/grocery-order] added ${added.length} item(s) to order ${orderId}: ${added.map((a) => a.product.name).join('; ')}`)
    return results
  },
}

export const ENRICHERS: Record<string, Enricher> = { movie, 'grocery-order': groceryOrder }

/** Full column list for a target: item + enricher columns + Added. */
export function columnsFor(enrich: string | undefined): string[] {
  const e = enrich ? ENRICHERS[enrich] : undefined
  if (!e) return [ITEM_COLUMN, ADDED_COLUMN]
  const item = e.itemColumn ?? ITEM_COLUMN
  return [...new Set([item, ...e.columns, ADDED_COLUMN])]
}

/** The raw row the ring writes: item in its column, defaults, Added stamp. */
export function rawRow(enrich: string | undefined, item: string, added: string): Record<string, string> {
  const e = enrich ? ENRICHERS[enrich] : undefined
  return { [e?.itemColumn ?? ITEM_COLUMN]: item, ...(e?.defaults ?? {}), [ADDED_COLUMN]: added }
}
