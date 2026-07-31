// ============================================================================
// AWS Bedrock cost analytics — pure software, no AI involved.
//
// Feeds the Home pane's "Bedrock spend" chart: daily cost over time, stacked by
// user. Data comes from AWS Cost Explorer via the `aws` CLI (no SDK dependency
// — the hub already shells out to `tailscale`/`pm2` in dashboard.ts, and the CE
// surface we need is three flags wide).
//
// THREE load-bearing facts about how Bedrock spend actually shows up in CE,
// each of which silently yields an all-zero chart if you get it wrong:
//
//  1. **`SERVICE` is NOT "Amazon Bedrock".** Anthropic/OpenAI models are billed
//     as AWS Marketplace products, one service per model: `Claude Opus 5
//     (Amazon Bedrock Edition)`, `Claude Fable 5 (Amazon Bedrock Edition)`, …
//     Filtering on `SERVICE = "Amazon Bedrock"` returns $0. We therefore do NOT
//     filter by service at all — we group by it and classify client-side on the
//     `(Amazon Bedrock Edition)` suffix, which costs one request instead of two
//     and automatically picks up model names that don't exist yet.
//
//  2. **`RECORD_TYPE` must be pinned to `Usage`.** This account's Bedrock spend
//     is fully offset by promotional credits, so the NET (`UnblendedCost` with
//     no record-type filter) is exactly $0.00 — credits mirror usage to the
//     cent. `Usage` is the real consumption, which is what "usage over time"
//     means here; the credit line is a separate accounting fact.
//
//  3. **Per-user attribution rides the `owner` cost-allocation tag**, which is
//     carried by *application inference profiles* (`<user>-cc-<model>`, tagged
//     `owner=<user>` + `app=claude-code`). Two independent things break it:
//     (a) tagging a resource is NOT the same as *activating* the tag key in
//     Billing — `owner` sat Inactive until 2026-07-29 (see OWNER_TAG_EPOCH), and
//     activation does not backfill; (b) a request made against a bare model id
//     (`us.anthropic.claude-opus-5`) routes around every profile and lands
//     untagged permanently. (b) is fixed — bedrock-profiles.ts swaps in the
//     owner-tagged ARN at spawn — so untagged spend on a post-epoch day now means
//     spend that originated OUTSIDE this hub. It is surfaced as its own explicit
//     `untagged` series, never hidden and never folded into a person.
//
// One exception carves real attribution out of that residual: see
// REGION_ATTRIBUTION below.
//
// Cost Explorer bills ~$0.01 per request, so results are cached on disk with a
// TTL and only refreshed on demand or when stale.
// ============================================================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const execFileP = promisify(execFile)

/** Marketplace service-name suffix every Bedrock-served model shares. */
const BEDROCK_SUFFIX = ' (Amazon Bedrock Edition)'
/** The day the `owner` cost-allocation tag was activated in Billing
 *  (`LastUpdatedDate: 2026-07-29T22:13:41Z`). Tagging a resource is not enough —
 *  until the key is *activated* CE has no dimension to group by, and activation
 *  does NOT backfill. Every dollar before this date is permanently
 *  unattributable, so the chart marks the region rather than letting it read as
 *  "all one person". */
export const OWNER_TAG_EPOCH = '2026-07-29'
/** CE group key for spend that carried no `owner` tag. */
const UNTAGGED = 'untagged'

/** `owner` tag value → the person's display name, so the chart reads as PEOPLE
 *  rather than as infrastructure identifiers. The tag values are fixed by the
 *  inference profiles already provisioned in AWS (`<owner>-cc-<model>`) and can't
 *  be renamed retroactively without orphaning historical CE data, so the mapping
 *  lives here instead. Overridable/extendable at
 *  `~/.config/console/cost-owners.json` (`{"<tag>": "<Name>"}`) — that's how a new
 *  person gets a label without a code change, once they have their own profiles. */
const BUILTIN_OWNER_NAMES: Record<string, string> = {
  amar: 'Yousef',
  sam: 'Sam',
  guest1: 'Lucas',
  deenai: 'deen.ai',
}

/**
 * REGION → owner, for regions where a SINGLE workload is the only Bedrock
 * consumer. Untagged Bedrock spend in such a region is attributable with
 * certainty rather than by inference, which is the one way to get real
 * attribution for days before that workload's profile existed (cost-allocation
 * tags never backfill, so CE itself can't).
 *
 * `eu-west-2` is deen.ai's Lambda (`deen-wa-cloud`) and nothing else — the agent
 * fleet is entirely us-east-1. Its `DEEN_MODEL` was a bare model id until
 * 2026-07-31, so every eu-west-2 dollar before then is untagged at CE and would
 * otherwise sit in the residual bucket forever.
 *
 * Only ever add a region you've confirmed is single-tenant: this MOVES money
 * from `untagged` onto a named owner, so a wrong entry is a confidently wrong
 * chart rather than an obviously incomplete one.
 */
const REGION_ATTRIBUTION: Record<string, string> = { 'eu-west-2': 'deenai' }

/** Cost Explorer is only ever queried from us-east-1 (global endpoint). */
const CE_REGION = 'us-east-1'
/** CE refreshes upstream a few times a day; anything tighter just burns $0.01s. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const MAX_DAYS = 180
const AWS_TIMEOUT_MS = 30_000

export interface CostDay {
  /** `YYYY-MM-DD` (inclusive start of the CE daily bucket). */
  date: string
  /** owner tag value (or `untagged`) → USD for that day. */
  byOwner: Record<string, number>
  /** model label (service name minus the Marketplace suffix) → USD. */
  byModel: Record<string, number>
  usd: number
}

export interface CostReport {
  /** When this report was produced (epoch ms). */
  generatedAt: number
  start: string
  end: string
  days: CostDay[]
  /** Owners present anywhere in the window, biggest total spend first. */
  owners: string[]
  /** Models present anywhere in the window, biggest total spend first. */
  models: string[]
  totalUsd: number
  /** Mean USD/day over COMPLETE days only. The last bucket is always today (see
   *  `costWindow` — `end` is tomorrow), which CE has billed only partially, so
   *  including it drags the mean down every single morning. */
  avgPerDayUsd: number
  /** Number of days `avgPerDayUsd` averages over (today excluded). */
  avgDayCount: number
  /** Today's partial spend, kept separate from the mean for the same reason. */
  todayUsd: number
  /** Per-owner total across the window. */
  totalByOwner: Record<string, number>
  /** Per-model total across the window. */
  totalByModel: Record<string, number>
  /** True when every day is $0 — usually means the `aws` call succeeded but the
   *  account genuinely had no Bedrock spend, not that the query is broken. */
  empty: boolean
  /** First date on which per-user attribution is even possible. Days before it
   *  are all-`untagged` by construction, not by anyone's usage. */
  ownerTagEpoch: string
  /** `owner` tag value → person's display name, for every owner in the window.
   *  Sent with the report so the client renders people, not tag values, without
   *  duplicating the mapping. An owner with no known name maps to itself. */
  ownerNames: Record<string, string>
  /** Owner → USD that CE reported as untagged but which was attributed by
   *  single-tenant region instead (see REGION_ATTRIBUTION). Surfaced so the card
   *  can say the figure is region-derived rather than tag-derived. */
  regionAttributedUsd: Record<string, number>
}

// ---------------------------------------------------------------------------
// Pure parsing / aggregation (unit-tested — no AWS, no filesystem)
// ---------------------------------------------------------------------------

/** Shape of the slice of `aws ce get-cost-and-usage` output we consume. */
export interface CeResponse {
  ResultsByTime?: Array<{
    TimePeriod?: { Start?: string; End?: string }
    Groups?: Array<{
      Keys?: string[]
      Metrics?: Record<string, { Amount?: string; Unit?: string }>
    }>
  }>
}

/** `owner$amar` → `amar`; `owner$` (no tag on the resource) → `untagged`. */
export function parseOwnerKey(key: string): string {
  const idx = key.indexOf('$')
  const v = (idx === -1 ? key : key.slice(idx + 1)).trim()
  return v || UNTAGGED
}

/** `Claude Opus 5 (Amazon Bedrock Edition)` → `Claude Opus 5`. Returns null for
 *  services that aren't Bedrock model spend (EC2, S3, Tax, …). */
export function parseBedrockModel(service: string): string | null {
  if (!service.endsWith(BEDROCK_SUFFIX)) return null
  const label = service.slice(0, -BEDROCK_SUFFIX.length).trim()
  return label || null
}

/** Round to cents-ish precision so float noise doesn't leak into the wire
 *  format (CE returns 10 decimal places; sub-microdollar detail is meaningless
 *  and makes the JSON needlessly large). */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** Sort a `label → total` map's keys by descending total, ties alphabetical.
 *  `untagged` always sorts LAST regardless of size — it's a residual bucket, and
 *  keeping it at the end means the stacked chart's real users stay adjacent to
 *  the axis instead of being shoved around by it. */
function rankKeys(totals: Record<string, number>): string[] {
  return Object.keys(totals).sort((a, b) => {
    if (a === UNTAGGED) return 1
    if (b === UNTAGGED) return -1
    const d = (totals[b] ?? 0) - (totals[a] ?? 0)
    return d !== 0 ? d : a.localeCompare(b)
  })
}

/**
 * Sum untagged Bedrock spend per `date` → `region` from a CE response grouped by
 * `[DIMENSION REGION, DIMENSION SERVICE]` and filtered to `owner` ABSENT.
 * Non-Bedrock services are dropped, same as the main fold.
 */
export function parseUntaggedByRegion(
  res: CeResponse,
  metric = 'UnblendedCost',
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const bucket of res.ResultsByTime ?? []) {
    const date = bucket.TimePeriod?.Start
    if (!date) continue
    for (const g of bucket.Groups ?? []) {
      const [region, service] = g.Keys ?? []
      if (!region || !service) continue
      if (!parseBedrockModel(service)) continue
      const amount = Number(g.Metrics?.[metric]?.Amount ?? '0')
      if (!Number.isFinite(amount) || amount === 0) continue
      out[date] ??= {}
      out[date]![region] = round((out[date]![region] ?? 0) + amount)
    }
  }
  return out
}

/**
 * Fold a CE `get-cost-and-usage` response (grouped by `[TAG owner, DIMENSION
 * SERVICE]`) into a per-day report, keeping ONLY Bedrock model spend. Any other
 * service in the response is dropped — we deliberately query unfiltered (see
 * fact 1 in the header) so this classification step is what makes it Bedrock.
 *
 * `opts.untaggedByRegion` (from `parseUntaggedByRegion`) reassigns untagged spend
 * in single-tenant regions to that region's known owner — the only way to get
 * real attribution for days predating a workload's tagged profile.
 */
export function buildCostReport(
  res: CeResponse,
  opts: {
    metric?: string
    today?: string
    ownerNames?: Record<string, string>
    untaggedByRegion?: Record<string, Record<string, number>>
  } = {},
): Omit<CostReport, 'generatedAt'> {
  const metric = opts.metric ?? 'UnblendedCost'
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const days: CostDay[] = []
  const totalByOwner: Record<string, number> = {}
  const totalByModel: Record<string, number> = {}
  const regionAttributedUsd: Record<string, number> = {}
  let totalUsd = 0

  for (const bucket of res.ResultsByTime ?? []) {
    const date = bucket.TimePeriod?.Start
    if (!date) continue
    const day: CostDay = { date, byOwner: {}, byModel: {}, usd: 0 }

    for (const g of bucket.Groups ?? []) {
      const [ownerKey, service] = g.Keys ?? []
      if (!ownerKey || !service) continue
      const model = parseBedrockModel(service)
      if (!model) continue // not Bedrock model spend

      const amount = Number(g.Metrics?.[metric]?.Amount ?? '0')
      if (!Number.isFinite(amount) || amount === 0) continue

      const owner = parseOwnerKey(ownerKey)
      day.byOwner[owner] = round((day.byOwner[owner] ?? 0) + amount)
      day.byModel[model] = round((day.byModel[model] ?? 0) + amount)
      day.usd = round(day.usd + amount)
      totalByOwner[owner] = round((totalByOwner[owner] ?? 0) + amount)
      totalByModel[model] = round((totalByModel[model] ?? 0) + amount)
      totalUsd = round(totalUsd + amount)
    }

    // Move single-tenant-region spend out of the residual bucket and onto its
    // real owner. Clamped to what's actually in `untagged` for the day: the two
    // CE queries are independent, so a mismatch (a region newly gaining a tagged
    // profile mid-day) must never push `untagged` negative or inflate a person.
    for (const [region, ownerKey] of Object.entries(REGION_ATTRIBUTION)) {
      const avail = day.byOwner[UNTAGGED] ?? 0
      const move = Math.min(opts.untaggedByRegion?.[date]?.[region] ?? 0, avail)
      if (move <= 0) continue
      const left = round(avail - move)
      if (left > 0) day.byOwner[UNTAGGED] = left
      else delete day.byOwner[UNTAGGED]
      day.byOwner[ownerKey] = round((day.byOwner[ownerKey] ?? 0) + move)

      const totalLeft = round((totalByOwner[UNTAGGED] ?? 0) - move)
      if (totalLeft > 0) totalByOwner[UNTAGGED] = totalLeft
      else delete totalByOwner[UNTAGGED]
      totalByOwner[ownerKey] = round((totalByOwner[ownerKey] ?? 0) + move)
      regionAttributedUsd[ownerKey] = round((regionAttributedUsd[ownerKey] ?? 0) + move)
    }
    days.push(day)
  }

  const start = days[0]?.date ?? ''
  // CE buckets are [Start, End); the report's `end` is the last bucket's End so
  // it reads as an exclusive upper bound, matching the query we sent.
  const end = res.ResultsByTime?.[res.ResultsByTime.length - 1]?.TimePeriod?.End ?? ''

  // Average over complete days only. Today's bucket is real but partial, so
  // averaging it in would make the figure drop every morning and recover by
  // night; it's reported separately instead.
  const complete = days.filter((d) => d.date < today)
  const todayUsd = days.find((d) => d.date === today)?.usd ?? 0
  const avgPerDayUsd = complete.length
    ? round(complete.reduce((s, d) => s + d.usd, 0) / complete.length)
    : 0

  // Resolve a display name for every owner actually present, so the client never
  // has to guess (and `untagged` stays `untagged` — it isn't a person).
  const nameSource = { ...BUILTIN_OWNER_NAMES, ...(opts.ownerNames ?? {}) }
  const ownerNames: Record<string, string> = {}
  for (const o of Object.keys(totalByOwner)) {
    if (o !== UNTAGGED) ownerNames[o] = nameSource[o] ?? o
  }

  return {
    start,
    end,
    days,
    owners: rankKeys(totalByOwner),
    models: rankKeys(totalByModel),
    totalUsd,
    avgPerDayUsd,
    avgDayCount: complete.length,
    todayUsd,
    totalByOwner,
    totalByModel,
    empty: totalUsd === 0,
    ownerTagEpoch: OWNER_TAG_EPOCH,
    ownerNames,
    regionAttributedUsd,
  }
}

/** Inclusive-start / exclusive-end `YYYY-MM-DD` window covering the last
 *  `days` days, ending tomorrow so today's partial spend is included (CE's end
 *  bound is exclusive, so `End = today` would silently drop today). */
export function costWindow(days: number, now = new Date()): { start: string; end: string } {
  const clamped = Math.max(1, Math.min(MAX_DAYS, Math.floor(days) || 30))
  const day = 24 * 60 * 60 * 1000
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  // Anchor on UTC midnight — CE windows are date-only, and drifting by the
  // local offset would shift every bucket for anyone west of UTC.
  const todayUtc = new Date(`${iso(now)}T00:00:00Z`).getTime()
  return { start: iso(new Date(todayUtc - (clamped - 1) * day)), end: iso(new Date(todayUtc + day)) }
}

// ---------------------------------------------------------------------------
// AWS access + disk cache
// ---------------------------------------------------------------------------

/** Bump whenever `CostReport` gains a field. A report persisted by an older hub
 *  is missing the new key, and the UI renders `undefined` as `NaN` rather than
 *  failing loudly — so stale-shaped entries are dropped on load instead of being
 *  served for up to a TTL. */
const CACHE_VERSION = 4

interface CacheFile {
  version?: number
  /** Keyed by day-count so a 7-day and a 90-day view don't evict each other. */
  reports: Record<string, CostReport>
}

export class AwsCostStore {
  private cache: CacheFile = { reports: {} }
  private inflight = new Map<string, Promise<CostReport>>()

  constructor(
    private file: string,
    private log: (m: string) => void = () => {},
    private ttlMs = DEFAULT_TTL_MS,
    /** Optional `owner` tag → person name overrides, merged over the built-ins.
     *  Read fresh on each fetch so adding a person needs no hub restart. */
    private ownerNamesFile?: string,
  ) {
    this.load()
  }

  /** User-supplied owner→person names, if the file exists. Non-fatal: a missing
   *  or malformed file just falls back to the built-in map. */
  private ownerNameOverrides(): Record<string, string> {
    if (!this.ownerNamesFile || !existsSync(this.ownerNamesFile)) return {}
    try {
      const raw = JSON.parse(readFileSync(this.ownerNamesFile, 'utf-8')) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v
      return out
    } catch (e) {
      this.log(`[costs] owner-names file unreadable: ${(e as Error).message}`)
      return {}
    }
  }

  /** Cached report for the window, refetching when stale or forced. Concurrent
   *  callers for the same window share one AWS request (CE costs money per
   *  call, and the Home pane polls). */
  async get(days = 30, opts: { refresh?: boolean } = {}): Promise<CostReport> {
    const key = String(Math.max(1, Math.min(MAX_DAYS, Math.floor(days) || 30)))
    const cached = this.cache.reports[key]
    if (!opts.refresh && cached && Date.now() - cached.generatedAt < this.ttlMs) return cached

    const existing = this.inflight.get(key)
    if (existing) return existing

    const p = this.fetch(Number(key))
      .then((report) => {
        this.cache.reports[key] = report
        this.persist()
        return report
      })
      .catch((err) => {
        // A stale report beats an error page — the chart stays useful when the
        // AWS CLI is briefly unavailable (expired SSO, no network).
        if (cached) {
          this.log(`[costs] fetch failed, serving cached: ${(err as Error).message}`)
          return cached
        }
        throw err
      })
      .finally(() => { this.inflight.delete(key) })

    this.inflight.set(key, p)
    return p
  }

  /** Last cached report for a window, if any — no AWS call, no staleness check. */
  peek(days = 30): CostReport | null {
    return this.cache.reports[String(days)] ?? null
  }

  /** One `aws ce get-cost-and-usage` call. `--profile` is pinned explicitly: the
   *  hub inherits no AWS_PROFILE today, but an inherited one would silently point
   *  this at the wrong (Bedrock-invoke-only) identity, which lacks
   *  `ce:GetCostAndUsage`. */
  private async ce(
    start: string, end: string, filter: unknown, groupBy: unknown,
  ): Promise<CeResponse> {
    const { stdout } = await execFileP('aws', [
      'ce', 'get-cost-and-usage',
      '--region', CE_REGION,
      '--time-period', `Start=${start},End=${end}`,
      '--granularity', 'DAILY',
      '--metrics', 'UnblendedCost',
      '--filter', JSON.stringify(filter),
      '--group-by', JSON.stringify(groupBy),
      '--output', 'json',
      '--profile', process.env.CONSOLE_AWS_PROFILE || 'default',
    ], { timeout: AWS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: process.env })
    return JSON.parse(stdout) as CeResponse
  }

  private async fetch(days: number): Promise<CostReport> {
    const { start, end } = costWindow(days)
    // Usage only — credits mirror usage to the cent here, so the net is $0.
    const usageOnly = { Dimensions: { Key: 'RECORD_TYPE', Values: ['Usage'] } }

    // Two queries (CE caps group-by at 2 dimensions), issued together. The
    // second recovers per-region detail for spend that carries no `owner` tag,
    // which is what lets single-tenant regions be attributed anyway.
    const [main, untagged] = await Promise.all([
      this.ce(start, end, usageOnly, [
        { Type: 'TAG', Key: 'owner' },
        { Type: 'DIMENSION', Key: 'SERVICE' },
      ]),
      // Non-fatal: without it the report is still correct, just with those
      // dollars left in `untagged` — never worth failing the whole card for.
      this.ce(start, end, {
        And: [usageOnly, { Tags: { Key: 'owner', MatchOptions: ['ABSENT'] } }],
      }, [
        { Type: 'DIMENSION', Key: 'REGION' },
        { Type: 'DIMENSION', Key: 'SERVICE' },
      ]).catch((e: Error) => {
        this.log(`[costs] untagged-by-region query failed: ${e.message}`)
        return {} as CeResponse
      }),
    ])

    const report = buildCostReport(main, {
      ownerNames: this.ownerNameOverrides(),
      untaggedByRegion: parseUntaggedByRegion(untagged),
    })
    this.log(`[costs] ${start}..${end} → $${report.totalUsd.toFixed(2)} across ${report.owners.length} owner(s)`)
    return { generatedAt: Date.now(), ...report }
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<CacheFile>
      if (raw.version !== CACHE_VERSION) {
        this.log(`[costs] cache v${raw.version ?? 1} != v${CACHE_VERSION}, discarding`)
        return
      }
      if (raw.reports && typeof raw.reports === 'object') this.cache.reports = raw.reports
    } catch (e) {
      this.log(`[costs] cache load failed: ${(e as Error).message}`)
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, ...this.cache }, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      this.log(`[costs] cache save failed: ${(e as Error).message}`)
    }
  }
}
