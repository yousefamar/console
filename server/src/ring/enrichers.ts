// List enrichers — the SEPARATE step that fills a list row's extra columns
// after the raw row has landed. Each enricher declares the columns it owns,
// what "pending" looks like (an empty column, by Yousef's design: "empty
// means un-added"), and how to compute the fill. Run by the ListWatcher on
// any row in a configured list note — ring-written or typed by hand.

export interface Enricher {
  /** Columns this enricher owns, in table order (the raw row leaves them blank). */
  columns: string[]
  /** Column the spoken item lands in (default 'Item'). */
  itemColumn?: string
  /** Extra columns the raw row should carry with a default value. */
  defaults?: Record<string, string>
  /** Is this row still waiting for enrichment? */
  pending: (row: Record<string, string>) => boolean
  /** Compute the fill. null = could not enrich (left pending, retried later). */
  run: (row: Record<string, string>, deps: EnricherDeps) => Promise<Record<string, string> | null>
}

export interface EnricherDeps {
  /** One-shot LLM call on the small/fast model; null on failure. */
  llm: (prompt: string) => Promise<string | null>
}

export const ITEM_COLUMN = 'Item'
export const ADDED_COLUMN = 'Added'

/** `add movies <spoken>` → `| Title | Year | Series | Watched | Added |`;
 *  the LLM canonicalises the title and fills Year/Series. Pending = no Year. */
const movie: Enricher = {
  columns: ['Title', 'Year', 'Series', 'Watched'],
  itemColumn: 'Title',
  defaults: { Watched: 'No' },
  pending: (row) => !!row.title && !row.year,
  run: async (row, deps) => {
    const reply = await deps.llm([
      'A user spoke the name of a film or TV series to add to their watch list. Identify it and reply with exactly one JSON object, nothing else:',
      '  {"title":"<canonical title>","year":"<first release year, 4 digits>","series":"No" | "Yes" | "Yes (<network or season note>)"}',
      'If you genuinely cannot identify it, reply {"title":"","year":"","series":""}.',
      '',
      `Spoken: ${JSON.stringify(row.title)}`,
      'JSON:',
    ].join('\n'))
    if (!reply) return null
    const m = /\{[\s\S]*\}/.exec(reply)
    if (!m) return null
    try {
      const o = JSON.parse(m[0]) as { title?: unknown; year?: unknown; series?: unknown }
      const year = typeof o.year === 'string' || typeof o.year === 'number' ? String(o.year).trim() : ''
      if (!/^\d{4}$/.test(year)) return null
      const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : row.title!
      const series = typeof o.series === 'string' && o.series.trim() ? o.series.trim() : 'No'
      return { Title: title, Year: year, Series: series }
    } catch { return null }
  },
}

export const ENRICHERS: Record<string, Enricher> = { movie }
export type EnricherName = keyof typeof ENRICHERS

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
