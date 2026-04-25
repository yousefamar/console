// CashflowView — landing tab. Top: runway headline. Middle: projection chart
// with optional scenario overlays. Bottom: recurring streams list (manage)
// and a recurring-detection panel that suggests new streams from Monzo data.

import { useState } from 'react'
import { Plus, Trash2, Zap } from 'lucide-react'
import { useFinanceStore, fmtPence, type Stream } from '@/store/finance'
import { RunwayCard } from './RunwayCard'
import { ProjectionChart } from './ProjectionChart'
import { MonthlySpendChart } from './MonthlySpendChart'

export function CashflowView() {
  const settings = useFinanceStore((s) => s.settings)
  const updateSettings = useFinanceStore((s) => s.updateSettings)
  const scenarios = useFinanceStore((s) => s.scenarios)
  const activeScenarioId = useFinanceStore((s) => s.activeScenarioId)
  const setActiveScenario = useFinanceStore((s) => s.setActiveScenario)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="border-b border-border">
        <RunwayCard />
      </div>

      <div className="border-b border-border py-3">
        <div className="px-4 flex items-center justify-between mb-2">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Projection</h3>
          <div className="flex items-center gap-2 text-xs">
            <label className="text-text-tertiary">Horizon</label>
            <select
              value={settings?.projectionHorizonMonths ?? 24}
              onChange={(e) => updateSettings({ projectionHorizonMonths: parseInt(e.target.value, 10) })}
              className="bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5"
            >
              {[6, 12, 24, 36, 60].map((n) => <option key={n} value={n}>{n} mo</option>)}
            </select>
            {scenarios.length > 0 && (
              <>
                <label className="text-text-tertiary ml-2">Active scenario</label>
                <select
                  value={activeScenarioId ?? ''}
                  onChange={(e) => setActiveScenario(e.target.value || null)}
                  className="bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5 max-w-[160px]"
                >
                  <option value="">None</option>
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </>
            )}
          </div>
        </div>
        <ProjectionChart />
      </div>

      <MonthlySpendChart />
      <StreamsPanel />
      <RecurringSuggestions />
      <EmergencyFundEditor />
    </div>
  )
}

// --- Streams ----------------------------------------------------------------

function StreamsPanel() {
  const streams = useFinanceStore((s) => s.streams)
  const [editing, setEditing] = useState<Stream | 'new' | null>(null)

  const income = streams.filter((s) => s.kind === 'income' && !s.archived)
  const expense = streams.filter((s) => s.kind === 'expense' && !s.archived)

  return (
    <div className="border-b border-border py-3">
      <div className="px-4 flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Recurring streams</h3>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary"
        >
          <Plus size={12} />Add stream
        </button>
      </div>
      <div className="px-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <Column title="Income" rows={income} onEdit={setEditing} />
        <Column title="Expenses" rows={expense} onEdit={setEditing} />
      </div>
      {editing && <StreamEditor stream={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Column({ title, rows, onEdit }: { title: string; rows: Stream[]; onEdit: (s: Stream) => void }) {
  const categories = useFinanceStore((s) => s.categories)
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-text-tertiary py-2">No {title.toLowerCase()} streams yet.</div>
      ) : (
        <div className="space-y-1">
          {rows.map((s) => {
            const cat = s.categoryId ? categories.find((c) => c.id === s.categoryId) : null
            return (
              <button key={s.id} onClick={() => onEdit(s)}
                className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-surface-2 group">
                <span className="w-5 text-center">{cat?.emoji ?? (s.kind === 'income' ? '💰' : '💸')}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary truncate">{s.name}</div>
                  <div className="text-[10px] text-text-tertiary">{cadenceLabel(s)}{cat ? ` · ${cat.name}` : ''}</div>
                </div>
                <div className={`text-xs tabular-nums ${s.kind === 'income' ? 'text-green-400' : 'text-text-primary'}`}>
                  {s.kind === 'income' ? '+' : '-'}{fmtPence(s.amountPence, { abs: true })}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function cadenceLabel(s: Stream): string {
  if (s.cadence === 'monthly') return s.dayOfMonth ? `Monthly · day ${s.dayOfMonth}` : 'Monthly'
  if (s.cadence === 'yearly') return s.monthOfYear ? `Yearly · ${monthName(s.monthOfYear)}` : 'Yearly'
  return 'Weekly'
}

function monthName(m: number): string {
  return new Date(2000, m - 1, 1).toLocaleDateString('en-GB', { month: 'short' })
}

function StreamEditor({ stream, onClose }: { stream: Stream | null; onClose: () => void }) {
  const upsertStream = useFinanceStore((s) => s.upsertStream)
  const deleteStream = useFinanceStore((s) => s.deleteStream)
  const categories = useFinanceStore((s) => s.categories)
  const accounts = useFinanceStore((s) => s.accounts)

  const [name, setName] = useState(stream?.name ?? '')
  const [kind, setKind] = useState<Stream['kind']>(stream?.kind ?? 'expense')
  const [pounds, setPounds] = useState(stream ? (stream.amountPence / 100).toFixed(2) : '')
  const [cadence, setCadence] = useState<Stream['cadence']>(stream?.cadence ?? 'monthly')
  const [dayOfMonth, setDayOfMonth] = useState(stream?.dayOfMonth?.toString() ?? '1')
  const [monthOfYear, setMonthOfYear] = useState(stream?.monthOfYear?.toString() ?? '1')
  const [startDate, setStartDate] = useState(stream?.startDate ?? new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState(stream?.endDate ?? '')
  const [categoryId, setCategoryId] = useState(stream?.categoryId ?? '')
  const [accountId, setAccountId] = useState(stream?.accountId ?? '')
  const [growth, setGrowth] = useState(stream?.growthPctYoy?.toString() ?? '')
  const [notes, setNotes] = useState(stream?.notes ?? '')

  const save = async () => {
    const amountPence = Math.round(parseFloat(pounds) * 100)
    if (!name || !amountPence) return
    await upsertStream({
      id: stream?.id,
      name,
      kind,
      amountPence,
      cadence,
      dayOfMonth: cadence === 'monthly' ? parseInt(dayOfMonth, 10) : undefined,
      monthOfYear: cadence === 'yearly' ? parseInt(monthOfYear, 10) : undefined,
      startDate,
      endDate: endDate || undefined,
      categoryId: categoryId || undefined,
      accountId: accountId || undefined,
      growthPctYoy: growth ? parseFloat(growth) : undefined,
      notes: notes || undefined,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface-0 border border-border rounded-md p-4 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">{stream ? 'Edit stream' : 'New stream'}</h3>
          {stream && (
            <button onClick={async () => { if (confirm('Delete stream?')) { await deleteStream(stream.id); onClose() } }}
              className="text-text-tertiary hover:text-red-400">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="space-y-2 text-xs">
          <Input label="Name" value={name} onChange={setName} />
          <Row>
            <Select label="Kind" value={kind} options={[['income', 'Income'], ['expense', 'Expense']]} onChange={(v) => setKind(v as Stream['kind'])} />
            <Input label="Amount (£)" value={pounds} onChange={setPounds} type="number" />
          </Row>
          <Row>
            <Select label="Cadence" value={cadence}
              options={[['monthly', 'Monthly'], ['yearly', 'Yearly'], ['weekly', 'Weekly']]}
              onChange={(v) => setCadence(v as Stream['cadence'])} />
            {cadence === 'monthly' && <Input label="Day of month" value={dayOfMonth} onChange={setDayOfMonth} type="number" />}
            {cadence === 'yearly' && <Input label="Month (1-12)" value={monthOfYear} onChange={setMonthOfYear} type="number" />}
          </Row>
          <Row>
            <Input label="Start" value={startDate} onChange={setStartDate} type="date" />
            <Input label="End (optional)" value={endDate} onChange={setEndDate} type="date" />
          </Row>
          <Row>
            <Select label="Category"
              value={categoryId}
              options={[['', '— none —'], ...categories.filter((c) => kind === 'income' ? c.kind === 'income' : c.kind === 'expense').map((c) => [c.id, `${c.emoji} ${c.name}`] as [string, string])]}
              onChange={setCategoryId}
            />
            <Select label="Account"
              value={accountId}
              options={[['', '— any —'], ...accounts.filter((a) => !a.archived).map((a) => [a.id, `${a.emoji ?? ''} ${a.name}`] as [string, string])]}
              onChange={setAccountId}
            />
          </Row>
          <Input label="Annual growth %" value={growth} onChange={setGrowth} type="number" placeholder="e.g. 3 for 3% pay rise" />
          <Input label="Notes" value={notes} onChange={setNotes} />
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm">Cancel</button>
          <button onClick={save} className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm font-medium">Save</button>
        </div>
      </div>
    </div>
  )
}

// --- Recurring suggestion panel ---------------------------------------------

function RecurringSuggestions() {
  const candidates = useFinanceStore((s) => s.recurringCandidates).slice(0, 8)
  const streams = useFinanceStore((s) => s.streams)
  const upsertStream = useFinanceStore((s) => s.upsertStream)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  if (candidates.length === 0) return null

  const visible = candidates.filter((c) => !dismissed.has(c.key) && !streams.some((s) => s.name.toLowerCase() === c.label.toLowerCase()))
  if (visible.length === 0) return null

  return (
    <div className="border-b border-border py-3">
      <div className="px-4 flex items-center gap-2 mb-2">
        <Zap size={12} className="text-yellow-400" />
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Detected recurring</h3>
      </div>
      <div className="px-4 space-y-1">
        {visible.map((c) => (
          <div key={c.key} className="flex items-center justify-between gap-2 py-1 text-xs">
            <div className="min-w-0">
              <span className="text-text-primary truncate">{c.label}</span>
              <span className="text-text-tertiary ml-2">{c.occurrences}× · last {c.lastSeen}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`tabular-nums ${c.suggestedKind === 'income' ? 'text-green-400' : 'text-text-secondary'}`}>
                {c.suggestedKind === 'income' ? '+' : '-'}{fmtPence(c.amountPence, { abs: true })}
              </span>
              <button
                onClick={async () => {
                  await upsertStream({
                    name: c.label,
                    kind: c.suggestedKind,
                    amountPence: c.amountPence,
                    cadence: 'monthly',
                    startDate: new Date().toISOString().slice(0, 10),
                  })
                }}
                className="px-1.5 py-0.5 text-[10px] bg-surface-2 border border-border rounded-sm hover:bg-surface-1"
              >Add as stream</button>
              <button onClick={() => setDismissed((d) => new Set(d).add(c.key))}
                className="text-text-tertiary hover:text-text-secondary text-[10px]">Dismiss</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// --- Emergency fund editor --------------------------------------------------

function EmergencyFundEditor() {
  const settings = useFinanceStore((s) => s.settings)
  const updateSettings = useFinanceStore((s) => s.updateSettings)
  if (!settings) return null
  const ef = settings.emergencyFund

  return (
    <div className="border-b border-border py-3 px-4">
      <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">Emergency fund</h3>
      <div className="flex items-center gap-2 text-xs">
        <select
          value={ef.mode}
          onChange={(e) => {
            const mode = e.target.value as 'fixed' | 'months'
            const next = mode === 'fixed' ? { mode: 'fixed' as const, valuePence: 500_000 } : { mode: 'months' as const, months: 3 }
            updateSettings({ emergencyFund: next })
          }}
          className="bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5"
        >
          <option value="months">Months of burn</option>
          <option value="fixed">Fixed amount</option>
        </select>
        {ef.mode === 'months' ? (
          <input type="number" value={ef.months}
            onChange={(e) => updateSettings({ emergencyFund: { mode: 'months', months: parseInt(e.target.value, 10) || 0 } })}
            className="w-16 bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5" />
        ) : (
          <input type="number" value={ef.valuePence / 100}
            onChange={(e) => updateSettings({ emergencyFund: { mode: 'fixed', valuePence: Math.round(parseFloat(e.target.value) * 100) } })}
            className="w-24 bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5" />
        )}
        <span className="text-text-tertiary">{ef.mode === 'months' ? 'months' : '£'}</span>
      </div>
    </div>
  )
}

// --- Tiny form helpers ------------------------------------------------------

function Input({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string
}) {
  return (
    <label className="block flex-1 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">{label}</div>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary text-xs"
      />
    </label>
  )
}

function Select({ label, value, options, onChange }: {
  label: string; value: string; options: [string, string][]; onChange: (v: string) => void
}) {
  return (
    <label className="block flex-1 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary text-xs"
      >
        {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
    </label>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2">{children}</div>
}
