// ProjectionChart — line chart of projected liquid + total balance over the
// horizon, with a horizontal threshold for the emergency fund. Optionally
// overlays one or more scenarios for comparison.

import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
  CartesianGrid, Legend, Brush,
} from 'recharts'
import { useEffect, useState } from 'react'
import { useFinanceStore, fmtMonth, fmtPence, type MonthlyPoint } from '@/store/finance'
import { hubFetch } from '@/hub'

interface SeriesRow {
  month: string
  baselineLiquid: number
  baselineTotal: number
  [key: string]: number | string
}

export function ProjectionChart({ height = 320 }: { height?: number }) {
  const trajectory = useFinanceStore((s) => s.trajectory)
  const emergency = useFinanceStore((s) => s.emergencyFundPence)
  const scenarios = useFinanceStore((s) => s.scenarios)
  const horizon = useFinanceStore((s) => s.settings?.projectionHorizonMonths ?? 24)
  const activeScenarioId = useFinanceStore((s) => s.activeScenarioId)
  const [overlays, setOverlays] = useState<Record<string, MonthlyPoint[]>>({})

  // Pre-fetch every saved scenario's trajectory once for comparison.
  useEffect(() => {
    let cancelled = false
    Promise.all(scenarios.map(async (s): Promise<[string, MonthlyPoint[]]> => {
      try {
        const r = await hubFetch<{ trajectory: MonthlyPoint[] }>(`/finance/projection?horizon=${horizon}&scenario=${s.id}`)
        return [s.id, r.trajectory]
      } catch { return [s.id, [] as MonthlyPoint[]] }
    })).then((entries) => {
      if (cancelled) return
      const map: Record<string, MonthlyPoint[]> = {}
      for (const [id, t] of entries) map[id] = t
      setOverlays(map)
    })
    return () => { cancelled = true }
  }, [scenarios, horizon])

  if (trajectory.length === 0) {
    return <div className="px-4 py-12 text-center text-xs text-text-tertiary">Add accounts and streams to see the projection.</div>
  }

  const data: SeriesRow[] = trajectory.map((p, i) => {
    const row: SeriesRow = {
      month: p.month,
      baselineLiquid: p.liquidPence / 100,
      baselineTotal: p.totalPence / 100,
    }
    for (const s of scenarios) {
      const t = overlays[s.id]
      if (t && t[i]) row[`scn_${s.id}_liquid`] = t[i]!.liquidPence / 100
    }
    return row
  })

  return (
    <div style={{ width: '100%', height }} className="px-2">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="month" tickFormatter={fmtMonth} fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
          <YAxis fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }}
            tickFormatter={(v) => fmtPence(Math.round((v as number) * 100), { abs: true })} width={55} />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)', fontSize: 11, borderRadius: 4 }}
            labelStyle={{ color: 'var(--color-text-secondary)' }}
            formatter={((v: unknown, name: unknown) => [fmtPence(Math.round((v as number) * 100), { abs: true }), prettifyName(name as string, scenarios)]) as never}
            labelFormatter={((m: unknown) => fmtMonth(m as string)) as never}
          />
          <Legend formatter={(v: string) => prettifyName(v, scenarios)} wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
          <ReferenceLine y={emergency / 100} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'Emergency', fill: '#ef4444', fontSize: 10, position: 'right' }} />
          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="2 2" />
          <Line type="monotone" dataKey="baselineLiquid" stroke="#3b82f6" strokeWidth={2} dot={false} name="baselineLiquid" />
          <Line type="monotone" dataKey="baselineTotal" stroke="#a78bfa" strokeWidth={1} strokeDasharray="4 3" dot={false} name="baselineTotal" />
          {scenarios.map((s, i) => (
            <Line
              key={s.id}
              type="monotone"
              dataKey={`scn_${s.id}_liquid`}
              stroke={SCENARIO_COLORS[i % SCENARIO_COLORS.length]}
              strokeWidth={s.id === activeScenarioId ? 2 : 1.2}
              strokeDasharray={s.id === activeScenarioId ? '0' : '5 4'}
              dot={false}
              name={`scn_${s.id}_liquid`}
            />
          ))}
          <Brush
            dataKey="month"
            height={22}
            stroke="var(--color-border)"
            fill="var(--color-surface-1)"
            travellerWidth={8}
            tickFormatter={fmtMonth as never}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

const SCENARIO_COLORS = ['#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#fb7185']

function prettifyName(key: string, scenarios: { id: string; name: string }[]): string {
  if (key === 'baselineLiquid') return 'Liquid (baseline)'
  if (key === 'baselineTotal') return 'Total (baseline)'
  const m = key.match(/^scn_(.+)_liquid$/)
  if (m) {
    const s = scenarios.find((x) => x.id === m[1])
    return s ? `Scenario: ${s.name}` : key
  }
  return key
}
