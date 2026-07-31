// Bedrock spend — daily USD stacked by user, from AWS Cost Explorer.
//
// Pure software: the hub shells out to the `aws` CLI and this renders the
// result. See server/src/aws-costs.ts for the three CE gotchas (Marketplace
// service names, RECORD_TYPE=Usage, the `owner` cost-allocation tag).
//
// `untagged` is shown as its own explicit series rather than hidden: requests
// made against a bare model id bypass the tagged inference profiles that carry
// `owner`, and cost-allocation tags don't backfill, so it's a real and
// sometimes dominant bucket. Hiding it would understate total spend. While the
// hub still spawns agents with bare model ids, stacking by MODEL is the
// informative cut — hence the by-user / by-model toggle.

import { useEffect, useMemo } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  ReferenceArea, ReferenceLine,
} from 'recharts'
import { useDashboardStore, COST_DAY_OPTIONS, type CostReport, type CostStackBy } from '@/store/dashboard'
import { HomeScrollPane } from './HomeScrollPane'

/** Cost Explorer data settles a few times a day; polling harder just bills more
 *  (the hub caches with its own TTL, but this bounds the request rate anyway). */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000

/** Stable per-owner colours. Palette is walked in the report's ranking order
 *  (biggest spender first) so the same user keeps a colour between renders;
 *  `untagged` is deliberately neutral grey — it isn't a person. */
const PALETTE = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6', '#ef4444', '#8b5cf6']
const UNTAGGED_COLOR = '#6b7280'

function colorFor(key: string, ranked: string[]): string {
  if (key === 'untagged') return UNTAGGED_COLOR
  const named = ranked.filter((o) => o !== 'untagged')
  return PALETTE[named.indexOf(key) % PALETTE.length]!
}

// Owner labels are the raw `owner` tag values (`amar`, `guest1`, `sam`) —
// deliberately not mapped to real names; the tags are already the pseudonyms.

function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

/** `2026-07-29` → `29 Jul`. Date-only string, parsed as UTC to match CE's
 *  date-only buckets (a local parse shifts the label a day west of UTC). */
function fmtDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function CostsCard() {
  const report = useDashboardStore((s) => s.costs)
  const loading = useDashboardStore((s) => s.costsLoading)
  const error = useDashboardStore((s) => s.costsError)
  const days = useDashboardStore((s) => s.costDays)
  const stackBy = useDashboardStore((s) => s.costStackBy)
  const refreshCosts = useDashboardStore((s) => s.refreshCosts)
  const setCostDays = useDashboardStore((s) => s.setCostDays)
  const setCostStackBy = useDashboardStore((s) => s.setCostStackBy)

  useEffect(() => {
    void refreshCosts()
    const t = setInterval(() => { void refreshCosts() }, REFRESH_INTERVAL_MS)
    return () => clearInterval(t)
  }, [refreshCosts])

  return (
    <section className="flex flex-col h-full min-h-0 border border-border rounded-sm bg-surface-1 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Bedrock spend
          {report && !report.empty && (
            <span className="ml-2 normal-case tracking-normal text-text-tertiary font-normal">
              {fmtUsd(report.totalUsd)}
              {/* Guarded: an older hub's cached report has no average fields. */}
              {Number.isFinite(report.avgPerDayUsd) && (
                <span
                  className="ml-1.5"
                  title={`Mean over ${report.avgDayCount} complete day(s); today (${fmtUsd(report.todayUsd)} so far) excluded because CE has only partially billed it`}
                >
                  · {fmtUsd(report.avgPerDayUsd)}/day
                </span>
              )}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5">
            {(['owner', 'model'] as CostStackBy[]).map((b) => (
              <button
                key={b}
                onClick={() => setCostStackBy(b)}
                className={`text-[10px] px-1.5 py-0.5 rounded-sm transition-colors duration-fast ${
                  b === stackBy ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                }`}
                title={b === 'owner'
                  ? 'Stack by user (owner tag)'
                  : 'Stack by model — the informative cut while most spend is untagged'}
              >
                {b === 'owner' ? 'user' : 'model'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5">
            {COST_DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setCostDays(d)}
                className={`text-[10px] px-1.5 py-0.5 rounded-sm transition-colors duration-fast ${
                  d === days ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={() => refreshCosts({ refresh: true })}
            disabled={loading}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast disabled:opacity-40"
            title="Force a fresh Cost Explorer query (~$0.01)"
          >
            ↻
          </button>
        </div>
      </header>

      <HomeScrollPane>
        {error ? (
          <div className="px-3 py-6 text-xs text-red-400">
            <div className="font-medium mb-1">Cost Explorer unavailable</div>
            <div className="text-text-tertiary break-words">{error}</div>
          </div>
        ) : !report ? (
          <div className="px-3 py-6 text-xs text-text-tertiary">{loading ? 'Querying AWS…' : 'No data.'}</div>
        ) : report.empty ? (
          <div className="px-3 py-6 text-xs text-text-tertiary">
            No Bedrock spend in the last {days} days.
          </div>
        ) : (
          <CostBody report={report} stackBy={stackBy} />
        )}
      </HomeScrollPane>
    </section>
  )
}

function CostBody({ report, stackBy }: { report: CostReport; stackBy: CostStackBy }) {
  const { data, series, unattributableUntil } = useMemo(() => {
    // Recharts stacks in element order; keys are ranked biggest-first with
    // `untagged` last, so the stack reads top-down the same way the legend does.
    const series = stackBy === 'owner' ? report.owners : report.models
    const data = report.days.map((d) => {
      const row: Record<string, number | string> = { date: d.date }
      const src = stackBy === 'owner' ? d.byOwner : d.byModel
      for (const k of series) row[k] = src[k] ?? 0
      return row
    })
    // Days before the owner tag was activated in Billing can never be split by
    // user — shade them so the all-untagged band doesn't read as real signal.
    const preEpoch = report.days.filter((d) => d.date < report.ownerTagEpoch)
    const unattributableUntil = stackBy === 'owner' && preEpoch.length
      ? { from: preEpoch[0]!.date, to: preEpoch[preEpoch.length - 1]!.date }
      : null
    return { data, series, unattributableUntil }
  }, [report, stackBy])

  return (
    <div className="flex flex-col gap-2 pb-2">
      <div style={{ width: '100%', height: 200 }} className="px-1 pt-2">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="date" tickFormatter={fmtDay} fontSize={9} minTickGap={18}
              stroke="var(--color-text-tertiary)" tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }}
            />
            <YAxis
              fontSize={9} width={44} stroke="var(--color-text-tertiary)" tickLine={false}
              axisLine={{ stroke: 'var(--color-border)' }} tickFormatter={(v) => fmtUsd(v as number)}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--color-surface-1)',
                border: '1px solid var(--color-border)',
                borderRadius: 2, fontSize: 11,
              }}
              labelFormatter={(l) => fmtDay(l as string)}
              formatter={(v, name) => [fmtUsd(v as number), name as string]}
            />
            <Legend
              wrapperStyle={{ fontSize: 10 }} iconType="square" iconSize={8}
              formatter={(v) => <span className="text-text-tertiary">{v}</span>}
            />
            {unattributableUntil ? (
              <ReferenceArea
                x1={unattributableUntil.from} x2={unattributableUntil.to}
                fill="var(--color-text-tertiary)" fillOpacity={0.08} strokeOpacity={0}
                label={{ value: 'no attribution', fontSize: 9, fill: 'var(--color-text-tertiary)' }}
              />
            ) : null}
            {report.avgPerDayUsd > 0 && Number.isFinite(report.avgPerDayUsd) ? (
              <ReferenceLine
                y={report.avgPerDayUsd} stroke="var(--color-text-tertiary)" strokeDasharray="3 3"
                label={{
                  value: `avg ${fmtUsd(report.avgPerDayUsd)}/day`, position: 'insideTopRight',
                  fontSize: 9, fill: 'var(--color-text-tertiary)',
                }}
              />
            ) : null}
            {series.map((k) => (
              <Area
                key={k} type="monotone" dataKey={k} stackId="1"
                stroke={colorFor(k, series)} fill={colorFor(k, series)}
                fillOpacity={0.35} strokeWidth={1.5} isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <BreakdownTable
        title="By user"
        totals={report.totalByOwner}
        order={report.owners}
        colorOf={stackBy === 'owner' ? (k) => colorFor(k, report.owners) : undefined}
        total={report.totalUsd}
      />
      <BreakdownTable
        title="By model"
        totals={report.totalByModel}
        order={report.models}
        colorOf={stackBy === 'model' ? (k) => colorFor(k, report.models) : undefined}
        total={report.totalUsd}
      />

      {report.totalByOwner.untagged ? (
        <p className="px-3 text-[10px] leading-snug text-text-tertiary">
          <span className="text-text-secondary">untagged</span> = requests that bypassed the
          per-user inference profiles carrying the <code>owner</code> tag (the hub spawns agents
          with bare model ids), plus everything before {fmtDay(report.ownerTagEpoch)} when the tag
          was activated in Billing — cost-allocation tags don't backfill.
        </p>
      ) : null}
    </div>
  )
}

function BreakdownTable({
  title, totals, order, colorOf, total,
}: {
  title: string
  totals: Record<string, number>
  order: string[]
  colorOf?: (k: string) => string
  total: number
}) {
  return (
    <div className="px-3">
      <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">{title}</div>
      <div className="flex flex-col gap-0.5">
        {order.map((k) => {
          const v = totals[k] ?? 0
          const pct = total > 0 ? (v / total) * 100 : 0
          return (
            <div key={k} className="flex items-center gap-2 text-xs">
              {colorOf ? (
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorOf(k) }} />
              ) : null}
              <span className={`flex-1 min-w-0 truncate ${k === 'untagged' ? 'text-text-tertiary' : 'text-text-secondary'}`}>
                {k}
              </span>
              <span className="text-[10px] text-text-tertiary tabular-nums">{pct.toFixed(0)}%</span>
              <span className="text-text-primary tabular-nums w-16 text-right">{fmtUsd(v)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
