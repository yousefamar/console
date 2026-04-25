// BudgetsView — per-category monthly target with actual + projected.

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useFinanceStore, fmtPence } from '@/store/finance'

export function BudgetsView() {
  const budgets = useFinanceStore((s) => s.budgets)
  const categories = useFinanceStore((s) => s.categories)
  const status = useFinanceStore((s) => s.budgetStatus)
  const upsertBudget = useFinanceStore((s) => s.upsertBudget)
  const deleteBudget = useFinanceStore((s) => s.deleteBudget)
  const [adding, setAdding] = useState(false)
  const [pickedCat, setPickedCat] = useState('')
  const [pounds, setPounds] = useState('')

  const expense = categories.filter((c) => c.kind === 'expense' && !c.archived && !c.isSystem)
  const totalTarget = budgets.reduce((a, b) => a + b.monthlyTargetPence, 0)
  const totalSpent = status.reduce((a, s) => a + s.spentPence, 0)
  const totalProjected = status.reduce((a, s) => a + s.projectedEndOfMonthPence, 0)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="border border-border rounded-sm mb-4 grid grid-cols-3 divide-x divide-border">
        <Tile label="Total target" value={fmtPence(totalTarget, { abs: true })} />
        <Tile label="Spent so far" value={fmtPence(totalSpent, { abs: true })} />
        <Tile label="Projected end of month"
          value={fmtPence(totalProjected, { abs: true })}
          warn={totalProjected > totalTarget} />
      </div>

      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Per-category</h3>
        {!adding && <button onClick={() => setAdding(true)} className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary">
          <Plus size={12} />Add budget
        </button>}
      </div>

      {adding && (
        <div className="border border-border rounded-sm p-2 mb-2 flex items-end gap-2 text-xs">
          <label className="flex-1">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Category</div>
            <select value={pickedCat} onChange={(e) => setPickedCat(e.target.value)}
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary">
              <option value="">Pick…</option>
              {expense.filter((c) => !budgets.some((b) => b.categoryId === c.id)).map((c) =>
                <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select>
          </label>
          <label className="w-32">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Monthly £</div>
            <input type="number" value={pounds} onChange={(e) => setPounds(e.target.value)}
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
          </label>
          <button onClick={async () => {
            const pence = Math.round(parseFloat(pounds) * 100)
            if (pickedCat && pence > 0) {
              await upsertBudget({ categoryId: pickedCat, monthlyTargetPence: pence })
              setAdding(false); setPickedCat(''); setPounds('')
            }
          }} className="px-2 py-1 bg-surface-2 border border-border rounded-sm">Save</button>
          <button onClick={() => setAdding(false)} className="px-2 py-1 text-text-tertiary">Cancel</button>
        </div>
      )}

      {budgets.length === 0 ? (
        <div className="text-xs text-text-tertiary py-6 text-center border border-dashed border-border rounded-sm">
          No budgets yet. Add one above to start tracking against a target.
        </div>
      ) : (
        <div className="space-y-2">
          {budgets.map((b) => {
            const cat = categories.find((c) => c.id === b.categoryId)
            const s = status.find((x) => x.budgetId === b.id)
            const spent = s?.spentPence ?? 0
            const projected = s?.projectedEndOfMonthPence ?? 0
            const pct = b.monthlyTargetPence > 0 ? Math.min(spent / b.monthlyTargetPence, 1.5) : 0
            const projectedPct = b.monthlyTargetPence > 0 ? Math.min(projected / b.monthlyTargetPence, 1.5) : 0
            const overspending = projected > b.monthlyTargetPence
            return (
              <div key={b.id} className="border border-border rounded-sm p-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span style={{ background: cat?.color, width: 6, height: 6, borderRadius: '50%' }} />
                    <span>{cat?.emoji} {cat?.name ?? b.categoryId}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] tabular-nums">
                    <span className="text-text-secondary">{fmtPence(spent, { abs: true })} / {fmtPence(b.monthlyTargetPence, { abs: true })}</span>
                    <span className={overspending ? 'text-red-400' : 'text-text-tertiary'}>proj. {fmtPence(projected, { abs: true })}</span>
                    <button onClick={async () => { if (confirm('Delete budget?')) await deleteBudget(b.id) }}
                      className="text-text-tertiary hover:text-red-400">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                <div className="h-2 bg-surface-2 rounded-full overflow-hidden relative">
                  <div className="absolute inset-y-0 left-0 bg-text-tertiary opacity-40 rounded-full"
                    style={{ width: `${Math.min(projectedPct, 1) * 100}%` }} />
                  <div className={`absolute inset-y-0 left-0 rounded-full ${overspending ? 'bg-red-500' : pct >= 1 ? 'bg-yellow-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(pct, 1) * 100}%`, background: !overspending ? cat?.color : undefined }} />
                  {projectedPct > 1 && (
                    <div className="absolute inset-y-0 right-0 bg-red-500/30"
                      style={{ width: `${Math.min((projectedPct - 1), 0.5) * 100}%` }} />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`text-lg font-medium tabular-nums ${warn ? 'text-red-400' : 'text-text-primary'}`}>{value}</div>
    </div>
  )
}
