// ScenariosView — what-if editor. A scenario is a baseline plus an ordered
// list of deltas. Side-by-side comparison chart of all scenarios overlays
// the projection so you can sanity-check "what if I quit?", "what if rent
// goes up £200?", "what if I land a £8k/mo job in Sept?".

import { useState, useEffect } from 'react'
import { Plus, Trash2, Copy, ChevronRight, ChevronDown } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
  CartesianGrid, Legend, Brush,
} from 'recharts'
import {
  useFinanceStore, fmtPence, fmtMonth, type Scenario, type Delta, type Stream,
  type MonthlyPoint,
} from '@/store/finance'
import { hubFetch } from '@/hub'
import { showConfirm } from '@/dialog'

const SCN_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#fb7185']

export function ScenariosView() {
  const scenarios = useFinanceStore((s) => s.scenarios)
  const upsertScenario = useFinanceStore((s) => s.upsertScenario)
  const horizon = useFinanceStore((s) => s.settings?.projectionHorizonMonths ?? 24)
  const baseTrajectory = useFinanceStore((s) => s.trajectory)
  const emergency = useFinanceStore((s) => s.emergencyFundPence)
  const [openId, setOpenId] = useState<string | null>(null)
  const [overlays, setOverlays] = useState<Record<string, MonthlyPoint[]>>({})

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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="border-b border-border p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Comparison</h3>
          <button
            onClick={async () => {
              const s = await upsertScenario({ name: 'New scenario', deltas: [] })
              setOpenId(s.id)
            }}
            className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary"
          >
            <Plus size={12} />New scenario
          </button>
        </div>

        <ComparisonChart base={baseTrajectory} overlays={overlays} scenarios={scenarios} emergency={emergency} />
      </div>

      <div className="p-4 space-y-2">
        {scenarios.length === 0 ? (
          <div className="text-xs text-text-tertiary py-6 text-center border border-dashed border-border rounded-sm">
            No scenarios yet. Try "What if I get a 10% raise next year?" or "What if rent goes up £300/mo from June?".
          </div>
        ) : scenarios.map((s, i) => {
          const traj = overlays[s.id]
          const final = traj?.[traj.length - 1]
          return (
            <div key={s.id} className="border border-border rounded-sm">
              <button onClick={() => setOpenId(openId === s.id ? null : s.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left">
                {openId === s.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="w-2 h-2 rounded-full" style={{ background: SCN_COLORS[(i + 1) % SCN_COLORS.length] }} />
                <span className="text-sm text-text-primary truncate flex-1">{s.name}</span>
                <span className="text-[11px] text-text-tertiary">{s.deltas.length} delta{s.deltas.length === 1 ? '' : 's'}</span>
                {final && (
                  <span className="text-[11px] tabular-nums text-text-secondary">
                    @ {fmtMonth(final.month)} → {fmtPence(final.liquidPence, { abs: true })}
                  </span>
                )}
              </button>
              {openId === s.id && <ScenarioEditor scenario={s} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ComparisonChart({
  base, overlays, scenarios, emergency,
}: {
  base: MonthlyPoint[];
  overlays: Record<string, MonthlyPoint[]>;
  scenarios: Scenario[];
  emergency: number;
}) {
  if (base.length === 0) {
    return <div className="py-6 text-center text-xs text-text-tertiary">No projection data yet.</div>
  }
  const data = base.map((p, i) => {
    const row: Record<string, number | string> = { month: p.month, baseline: p.liquidPence / 100 }
    for (const s of scenarios) {
      const t = overlays[s.id]
      if (t && t[i]) row[s.id] = t[i]!.liquidPence / 100
    }
    return row
  })

  return (
    <div style={{ width: '100%', height: 260 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="month" tickFormatter={fmtMonth} fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
          <YAxis fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }}
            tickFormatter={(v) => fmtPence(Math.round((v as number) * 100), { abs: true })} width={55} />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)', fontSize: 11, borderRadius: 4 }}
            labelStyle={{ color: 'var(--color-text-secondary)' }}
            formatter={((v: unknown, k: unknown) => [fmtPence(Math.round((v as number) * 100), { abs: true }), nameFor(k as string, scenarios)]) as never}
            labelFormatter={((m: unknown) => fmtMonth(m as string)) as never}
          />
          <Legend formatter={(v: string) => nameFor(v, scenarios)} wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
          <ReferenceLine y={emergency / 100} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'Emergency', fill: '#ef4444', fontSize: 10, position: 'right' }} />
          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="2 2" />
          <Line type="monotone" dataKey="baseline" stroke={SCN_COLORS[0]} strokeWidth={2} dot={false} name="baseline" />
          {scenarios.map((s, i) => (
            <Line key={s.id} type="monotone" dataKey={s.id}
              stroke={SCN_COLORS[(i + 1) % SCN_COLORS.length]} strokeWidth={1.4} dot={false} name={s.id} />
          ))}
          <Brush dataKey="month" height={20} stroke="var(--color-border)"
            fill="var(--color-surface-1)" travellerWidth={8} tickFormatter={fmtMonth as never} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function nameFor(k: string, scenarios: Scenario[]): string {
  if (k === 'baseline') return 'Baseline'
  return scenarios.find((s) => s.id === k)?.name ?? k
}

// --- Scenario editor --------------------------------------------------------

function ScenarioEditor({ scenario }: { scenario: Scenario }) {
  const upsertScenario = useFinanceStore((s) => s.upsertScenario)
  const deleteScenario = useFinanceStore((s) => s.deleteScenario)
  const streams = useFinanceStore((s) => s.streams)
  const categories = useFinanceStore((s) => s.categories)
  const [name, setName] = useState(scenario.name)
  const [description, setDescription] = useState(scenario.description ?? '')
  const [deltas, setDeltas] = useState<Delta[]>(scenario.deltas)

  // Push changes upward when name/description/deltas change (debounced via blur)
  const save = async () => {
    await upsertScenario({ id: scenario.id, name, description, deltas })
  }

  const addDelta = (d: Delta) => setDeltas([...deltas, d])
  const updateDelta = (i: number, patch: Partial<Delta>) => setDeltas(deltas.map((d, idx) => idx === i ? { ...d, ...patch } as Delta : d))
  const removeDelta = (i: number) => setDeltas(deltas.filter((_, idx) => idx !== i))

  return (
    <div className="border-t border-border p-3 bg-surface-1 space-y-3 text-xs">
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save}
          placeholder="Name"
          className="flex-1 px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary text-sm" />
        <button onClick={async () => {
          await upsertScenario({ name: `${scenario.name} (copy)`, deltas: scenario.deltas, description: scenario.description })
        }} className="px-2 py-1 bg-surface-2 border border-border rounded-sm flex items-center gap-1">
          <Copy size={11} />Clone
        </button>
        <button onClick={async () => { if (await showConfirm('Delete scenario?', { title: 'Delete scenario', danger: true, confirmLabel: 'Delete' })) await deleteScenario(scenario.id) }}
          className="px-2 py-1 text-text-tertiary hover:text-red-400">
          <Trash2 size={12} />
        </button>
      </div>
      <input value={description} onChange={(e) => setDescription(e.target.value)} onBlur={save}
        placeholder="Description (optional)"
        className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />

      <div>
        <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">Deltas</div>
        <div className="space-y-1">
          {deltas.map((d, i) => (
            <DeltaRow key={i} delta={d} streams={streams} categories={categories}
              onChange={(patch) => updateDelta(i, patch)}
              onRemove={() => removeDelta(i)}
            />
          ))}
        </div>
        <DeltaAdder onAdd={addDelta} streams={streams} categories={categories} />
        <button onClick={save} className="mt-2 px-3 py-1 bg-surface-2 border border-border rounded-sm font-medium">
          Save scenario
        </button>
      </div>
    </div>
  )
}

function DeltaRow({ delta, streams, categories, onChange, onRemove }: {
  delta: Delta;
  streams: Stream[];
  categories: ReturnType<typeof useFinanceStore.getState>['categories'];
  onChange: (patch: Partial<Delta>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="border border-border rounded-sm p-2 flex items-start gap-2">
      <div className="flex-1 text-[11px] space-y-1">
        {delta.kind === 'oneOff' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-text-tertiary">One-off</span>
            <input type="date" value={delta.date} onChange={(e) => onChange({ date: e.target.value } as Partial<Delta>)}
              className="px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
            <input type="number" value={(delta.amountPence / 100).toString()}
              onChange={(e) => onChange({ amountPence: Math.round(parseFloat(e.target.value) * 100) || 0 } as Partial<Delta>)}
              placeholder="£ (positive=in, negative=out)"
              className="w-32 px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
            <input value={delta.note ?? ''} onChange={(e) => onChange({ note: e.target.value } as Partial<Delta>)}
              placeholder="Note"
              className="flex-1 min-w-[120px] px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
          </div>
        )}
        {delta.kind === 'modifyStream' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-text-tertiary">Modify stream</span>
            <span className="text-text-primary">{streams.find((s) => s.id === delta.streamId)?.name ?? '?'}</span>
            <span className="text-text-tertiary">→ amount £</span>
            <input type="number"
              value={delta.patch.amountPence != null ? (delta.patch.amountPence / 100).toString() : ''}
              onChange={(e) => onChange({ patch: { ...delta.patch, amountPence: Math.round(parseFloat(e.target.value) * 100) || 0 } } as Partial<Delta>)}
              placeholder="(blank = unchanged)"
              className="w-28 px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
            <input type="date"
              value={delta.patch.startDate ?? ''}
              onChange={(e) => onChange({ patch: { ...delta.patch, startDate: e.target.value || undefined } } as Partial<Delta>)}
              className="px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
          </div>
        )}
        {delta.kind === 'terminateStream' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-text-tertiary">End stream</span>
            <span className="text-text-primary">{streams.find((s) => s.id === delta.streamId)?.name ?? '?'}</span>
            <span className="text-text-tertiary">on</span>
            <input type="date" value={delta.date} onChange={(e) => onChange({ date: e.target.value } as Partial<Delta>)}
              className="px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
          </div>
        )}
        {delta.kind === 'addStream' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-text-tertiary">New stream</span>
            <input value={delta.stream.name}
              onChange={(e) => onChange({ stream: { ...delta.stream, name: e.target.value } } as Partial<Delta>)}
              placeholder="name"
              className="px-1 py-0.5 bg-surface-2 border border-border rounded-sm w-32" />
            <select value={delta.stream.kind}
              onChange={(e) => onChange({ stream: { ...delta.stream, kind: e.target.value as Stream['kind'] } } as Partial<Delta>)}
              className="px-1 py-0.5 bg-surface-2 border border-border rounded-sm">
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
            <span className="text-text-tertiary">£</span>
            <input type="number" value={(delta.stream.amountPence / 100).toString()}
              onChange={(e) => onChange({ stream: { ...delta.stream, amountPence: Math.round(parseFloat(e.target.value) * 100) || 0 } } as Partial<Delta>)}
              className="w-24 px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
            <span className="text-text-tertiary">/mo from</span>
            <input type="date" value={delta.stream.startDate}
              onChange={(e) => onChange({ stream: { ...delta.stream, startDate: e.target.value } } as Partial<Delta>)}
              className="px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
          </div>
        )}
        {delta.kind === 'categoryAdjust' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-text-tertiary">Adjust</span>
            <select value={delta.categoryId}
              onChange={(e) => onChange({ categoryId: e.target.value } as Partial<Delta>)}
              className="px-1 py-0.5 bg-surface-2 border border-border rounded-sm">
              {categories.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select>
            <span className="text-text-tertiary">×</span>
            <input type="number" step="0.05" value={delta.multiplier}
              onChange={(e) => onChange({ multiplier: parseFloat(e.target.value) || 1 } as Partial<Delta>)}
              className="w-16 px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
            <span className="text-text-tertiary">(0.7 = -30%, 1.3 = +30%)</span>
          </div>
        )}
        {delta.kind === 'investmentGrowth' && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-text-tertiary">Investment growth</span>
            <input type="number" step="0.5" value={delta.annualPct}
              onChange={(e) => onChange({ annualPct: parseFloat(e.target.value) || 0 } as Partial<Delta>)}
              className="w-16 px-1 py-0.5 bg-surface-2 border border-border rounded-sm" />
            <span className="text-text-tertiary">%/yr</span>
          </div>
        )}
      </div>
      <button onClick={onRemove} className="text-text-tertiary hover:text-red-400">
        <Trash2 size={11} />
      </button>
    </div>
  )
}

function DeltaAdder({ onAdd, streams, categories }: {
  onAdd: (d: Delta) => void;
  streams: Stream[];
  categories: ReturnType<typeof useFinanceStore.getState>['categories'];
}) {
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      <button onClick={() => onAdd({ kind: 'oneOff', date: new Date().toISOString().slice(0, 10), amountPence: 0, note: '' })}
        className="px-2 py-1 text-[11px] bg-surface-2 border border-border rounded-sm">+ One-off</button>
      <button
        onClick={() => {
          if (streams.length === 0) return
          onAdd({ kind: 'modifyStream', streamId: streams[0]!.id, patch: {} })
        }}
        disabled={streams.length === 0}
        className="px-2 py-1 text-[11px] bg-surface-2 border border-border rounded-sm disabled:opacity-50"
      >+ Modify stream</button>
      <button
        onClick={() => {
          if (streams.length === 0) return
          onAdd({ kind: 'terminateStream', streamId: streams[0]!.id, date: new Date().toISOString().slice(0, 10) })
        }}
        disabled={streams.length === 0}
        className="px-2 py-1 text-[11px] bg-surface-2 border border-border rounded-sm disabled:opacity-50"
      >+ End stream</button>
      <button onClick={() => onAdd({ kind: 'addStream', tempId: `tmp_${Math.random().toString(36).slice(2, 8)}`, stream: {
        name: 'New stream',
        kind: 'income',
        amountPence: 0,
        cadence: 'monthly',
        startDate: new Date().toISOString().slice(0, 10),
      } })} className="px-2 py-1 text-[11px] bg-surface-2 border border-border rounded-sm">+ New stream</button>
      <button onClick={() => onAdd({ kind: 'categoryAdjust', categoryId: categories.find((c) => c.kind === 'expense')?.id ?? '', multiplier: 1 })}
        className="px-2 py-1 text-[11px] bg-surface-2 border border-border rounded-sm">+ Category multiplier</button>
      <button onClick={() => onAdd({ kind: 'investmentGrowth', annualPct: 5 })}
        className="px-2 py-1 text-[11px] bg-surface-2 border border-border rounded-sm">+ Investment growth</button>
    </div>
  )
}
