// MonthlySpendChart — stacked area of past N months of category spend, so the
// "where does my money go each month" question is answered at a glance. Uses
// the user's categories (rules + overrides) — Monzo's coarse 10 categories
// are not what gets rendered here. The trailing average panel below shows the
// per-category baseline that feeds the projection's variable-spend forecast.

import { useMemo, useState } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend,
} from 'recharts'
import { useFinanceStore, fmtMonth, fmtPence } from '@/store/finance'

const N_MONTHS_DEFAULT = 12

export function MonthlySpendChart() {
  const monthly = useFinanceStore((s) => s.monthly)
  const categories = useFinanceStore((s) => s.categories)
  const variableForecast = useFinanceStore((s) => s.variableForecast)
  const [windowMonths, setWindowMonths] = useState(N_MONTHS_DEFAULT)
  const [mode, setMode] = useState<'absolute' | 'percent'>('absolute')

  const { rows, activeCategoryIds } = useMemo(() => {
    const recent = monthly.slice(-windowMonths)
    // Find every category with at least one positive (outflow) value in window
    const seen = new Set<string>()
    for (const m of recent) {
      for (const [catId, pence] of Object.entries(m.byCategory)) {
        if (pence > 0) seen.add(catId)
      }
    }
    const ids = Array.from(seen)
    const byCatTotal = new Map<string, number>()
    for (const m of recent) {
      for (const id of ids) {
        const v = m.byCategory[id] ?? 0
        if (v > 0) byCatTotal.set(id, (byCatTotal.get(id) ?? 0) + v)
      }
    }
    const ordered = ids.sort((a, b) => (byCatTotal.get(b) ?? 0) - (byCatTotal.get(a) ?? 0))
    const rows = recent.map((m) => {
      const row: Record<string, number | string> = { month: m.month }
      let total = 0
      for (const id of ordered) {
        const v = m.byCategory[id] ?? 0
        row[id] = v > 0 ? v / 100 : 0
        total += v > 0 ? v : 0
      }
      if (mode === 'percent') {
        for (const id of ordered) {
          const pence = (row[id] as number) * 100
          row[id] = total > 0 ? (pence / total) * 100 : 0
        }
      }
      return row
    })
    return { rows, activeCategoryIds: ordered }
  }, [monthly, categories, windowMonths, mode])

  if (rows.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-text-tertiary">No spend history yet.</div>
  }

  const colorFor = (id: string) => categories.find((c) => c.id === id)?.color ?? '#94a3b8'
  const labelFor = (id: string) => {
    const c = categories.find((x) => x.id === id)
    return c ? `${c.emoji} ${c.name}` : id
  }

  return (
    <div className="border-b border-border py-3">
      <div className="px-4 flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Monthly spend by category</h3>
        <div className="flex items-center gap-2 text-xs">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'absolute' | 'percent')}
            className="bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5">
            <option value="absolute">£ absolute</option>
            <option value="percent">% of total</option>
          </select>
          <select value={windowMonths} onChange={(e) => setWindowMonths(parseInt(e.target.value, 10))}
            className="bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5">
            {[6, 12, 24, 36].map((n) => <option key={n} value={n}>{n} mo</option>)}
          </select>
        </div>
      </div>

      <div style={{ width: '100%', height: 260 }} className="px-2">
        <ResponsiveContainer>
          <AreaChart data={rows} margin={{ top: 4, right: 12, left: 4, bottom: 4 }} stackOffset="none">
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="month" tickFormatter={fmtMonth} fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
            <YAxis fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }}
              tickFormatter={(v) => mode === 'percent'
                ? `${Math.round(v as number)}%`
                : fmtPence(Math.round((v as number) * 100), { abs: true })}
              width={mode === 'percent' ? 40 : 55}
              domain={mode === 'percent' ? [0, 100] : ['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)', fontSize: 11, borderRadius: 4 }}
              labelStyle={{ color: 'var(--color-text-secondary)' }}
              labelFormatter={((m: unknown) => fmtMonth(m as string)) as never}
              formatter={((v: unknown, k: unknown) => [
                mode === 'percent'
                  ? `${(v as number).toFixed(1)}%`
                  : fmtPence(Math.round((v as number) * 100), { abs: true }),
                labelFor(k as string),
              ]) as never}
            />
            <Legend formatter={(v: string) => labelFor(v)} wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
            {activeCategoryIds.map((id) => (
              <Area key={id} type="monotone" dataKey={id} stackId="1"
                stroke={colorFor(id)} fill={colorFor(id)} fillOpacity={0.7} name={id} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <ForecastPanel forecast={variableForecast} />
    </div>
  )
}

function ForecastPanel({ forecast }: { forecast: Record<string, number> }) {
  const categories = useFinanceStore((s) => s.categories)
  const entries = Object.entries(forecast).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const total = entries.reduce((a, [, v]) => a + v, 0)
  return (
    <div className="px-4 mt-3">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
        Trailing 3-mo avg (used for projection forecast) — total {fmtPence(total, { abs: true })}/mo
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
        {entries.map(([id, pence]) => {
          const cat = categories.find((c) => c.id === id)
          return (
            <div key={id} className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: cat?.color ?? '#94a3b8' }} />
              <span className="text-text-secondary truncate flex-1">{cat?.emoji} {cat?.name ?? id}</span>
              <span className="text-text-tertiary tabular-nums">{fmtPence(pence, { abs: true })}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
