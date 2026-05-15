// CategoriesView — manage user-defined categories and the rules that map
// transactions onto them. Rules run in priority order (lower number = first).

import { useState } from 'react'
import { Plus, Trash2, ArrowDown } from 'lucide-react'
import { useFinanceStore, type Category, type CategoryRule } from '@/store/finance'
import { showConfirm } from '@/dialog'
import { MoneyScrollPane } from './MoneyScrollPane'

export function CategoriesView() {
  const [tab, setTab] = useState<'categories' | 'rules'>('categories')

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="border-b border-border px-4 flex gap-3 text-xs">
        {(['categories', 'rules'] as const).map((t) => (
          <button key={t}
            onClick={() => setTab(t)}
            className={`py-2 border-b-2 transition-colors ${tab === t ? 'border-text-primary text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}`}
          >
            {t === 'categories' ? 'Categories' : 'Rules'}
          </button>
        ))}
      </div>
      <MoneyScrollPane className="flex-1 min-h-0 overflow-y-auto p-4">
        {tab === 'categories' ? <CategoriesPanel /> : <RulesPanel />}
      </MoneyScrollPane>
    </div>
  )
}

// --- Categories -------------------------------------------------------------

function CategoriesPanel() {
  const categories = useFinanceStore((s) => s.categories)
  const upsertCategory = useFinanceStore((s) => s.upsertCategory)
  const deleteCategory = useFinanceStore((s) => s.deleteCategory)
  const [editing, setEditing] = useState<Category | 'new' | null>(null)

  const grouped = {
    income: categories.filter((c) => c.kind === 'income'),
    expense: categories.filter((c) => c.kind === 'expense'),
    transfer: categories.filter((c) => c.kind === 'transfer'),
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <button onClick={() => setEditing('new')}
          className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary">
          <Plus size={12} />New category
        </button>
      </div>

      {(['income', 'expense', 'transfer'] as const).map((kind) => (
        <section key={kind} className="mb-4">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">{kind}</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
            {grouped[kind].map((c) => (
              <button key={c.id}
                onClick={() => setEditing(c)}
                className="flex items-center gap-2 px-2 py-1.5 border border-border rounded-sm hover:bg-surface-2 text-left">
                <span style={{ background: c.color, width: 6, height: 6, borderRadius: '50%' }} />
                <span className="w-5 text-center">{c.emoji}</span>
                <span className="text-xs text-text-primary truncate">{c.name}</span>
                {c.isSystem && <span className="text-[9px] text-text-tertiary uppercase">sys</span>}
              </button>
            ))}
          </div>
        </section>
      ))}

      {editing && (
        <CategoryEditor
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => { await upsertCategory(input); setEditing(null) }}
          onDelete={editing !== 'new' && !editing.isSystem
            ? async () => { await deleteCategory((editing as Category).id); setEditing(null) }
            : undefined}
        />
      )}
    </div>
  )
}

function CategoryEditor({ category, onClose, onSave, onDelete }: {
  category: Category | null;
  onClose: () => void;
  onSave: (c: Partial<Category> & { name: string }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [emoji, setEmoji] = useState(category?.emoji ?? '🏷️')
  const [color, setColor] = useState(category?.color ?? '#94a3b8')
  const [kind, setKind] = useState<Category['kind']>(category?.kind ?? 'expense')
  const [variable, setVariable] = useState(category?.variable ?? true)

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface-0 border border-border rounded-md p-4 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">{category ? 'Edit category' : 'New category'}</h3>
          {onDelete && (
            <button onClick={async () => { if (await showConfirm('Delete category? Rules and budgets pointing here will be removed.', { title: 'Delete category', danger: true, confirmLabel: 'Delete' })) await onDelete() }}
              className="text-text-tertiary hover:text-red-400">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="space-y-2 text-xs">
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Name</div>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
          </label>
          <div className="flex gap-2">
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Emoji</div>
              <input value={emoji} onChange={(e) => setEmoji(e.target.value)}
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
            </label>
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Colour</div>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                className="w-full h-7 px-1 bg-surface-2 border border-border rounded-sm" />
            </label>
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Kind</div>
              <select value={kind} onChange={(e) => setKind(e.target.value as Category['kind'])}
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary">
                <option value="income">Income</option>
                <option value="expense">Expense</option>
                <option value="transfer">Transfer</option>
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={variable} onChange={(e) => setVariable(e.target.checked)} />
            <span>Variable spend (use trailing-3-mo avg in projections)</span>
          </label>
          <p className="text-[10px] text-text-tertiary">Uncheck for categories that come from streams (rent, salary), so the projection doesn't double-count.</p>
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm">Cancel</button>
          <button onClick={() => onSave({ id: category?.id, name, emoji, color, kind, variable })}
            className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm font-medium">Save</button>
        </div>
      </div>
    </div>
  )
}

// --- Rules ------------------------------------------------------------------

function RulesPanel() {
  const rules = useFinanceStore((s) => s.rules)
  const categories = useFinanceStore((s) => s.categories)
  const upsertRule = useFinanceStore((s) => s.upsertRule)
  const deleteRule = useFinanceStore((s) => s.deleteRule)
  const [editing, setEditing] = useState<CategoryRule | 'new' | null>(null)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] text-text-tertiary">
          Rules run in priority order (lower number first). The first match wins.
        </p>
        <button onClick={() => setEditing('new')}
          className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary">
          <Plus size={12} />New rule
        </button>
      </div>

      <div className="space-y-1">
        {rules.map((r) => {
          const cat = categories.find((c) => c.id === r.categoryId)
          return (
            <button key={r.id} onClick={() => setEditing(r)}
              className="w-full text-left flex items-center gap-2 px-2 py-1.5 border border-border rounded-sm hover:bg-surface-2 text-xs">
              <span className="text-text-tertiary w-8 tabular-nums">{r.priority}</span>
              <span className="flex-1 min-w-0 truncate">
                {r.label || describeMatch(r.match)}
              </span>
              <ArrowDown size={11} className="text-text-tertiary" />
              <span className="text-text-primary truncate flex items-center gap-1">
                {cat?.emoji} {cat?.name ?? r.categoryId}
              </span>
            </button>
          )
        })}
      </div>

      {editing && (
        <RuleEditor rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => { await upsertRule(input); setEditing(null) }}
          onDelete={editing !== 'new' ? async () => { await deleteRule((editing as CategoryRule).id); setEditing(null) } : undefined}
        />
      )}
    </div>
  )
}

function describeMatch(m: CategoryRule['match']): string {
  const parts: string[] = []
  if (m.merchantContains) parts.push(`merchant ~ "${m.merchantContains}"`)
  if (m.descriptionContains) parts.push(`description ~ "${m.descriptionContains}"`)
  if (m.counterpartyContains) parts.push(`counterparty ~ "${m.counterpartyContains}"`)
  if (m.amountSign) parts.push(`amount ${m.amountSign === 'in' ? '> 0' : '< 0'}`)
  if (m.monzoCategoryEquals) parts.push(`monzo cat = "${m.monzoCategoryEquals}"`)
  return parts.join(' AND ') || '(empty)'
}

function RuleEditor({ rule, onClose, onSave, onDelete }: {
  rule: CategoryRule | null;
  onClose: () => void;
  onSave: (r: Partial<CategoryRule> & { categoryId: string; match: CategoryRule['match'] }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const categories = useFinanceStore((s) => s.categories)
  const [priority, setPriority] = useState(rule?.priority?.toString() ?? '50')
  const [label, setLabel] = useState(rule?.label ?? '')
  const [merchant, setMerchant] = useState(rule?.match.merchantContains ?? '')
  const [description, setDescription] = useState(rule?.match.descriptionContains ?? '')
  const [counterparty, setCounterparty] = useState(rule?.match.counterpartyContains ?? '')
  const [sign, setSign] = useState<'' | 'in' | 'out'>(rule?.match.amountSign ?? '')
  const [monzoCat, setMonzoCat] = useState(rule?.match.monzoCategoryEquals ?? '')
  const [categoryId, setCategoryId] = useState(rule?.categoryId ?? '')
  const [ignore, setIgnore] = useState(!!rule?.ignore)
  const [asTransfer, setAsTransfer] = useState(!!rule?.asTransfer)
  const [sharedFraction, setSharedFraction] = useState(rule?.sharedFraction != null ? rule.sharedFraction.toString() : '')
  const [sharedCounterparty, setSharedCounterparty] = useState(rule?.sharedWithCounterparty ?? '')

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface-0 border border-border rounded-md p-4 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">{rule ? 'Edit rule' : 'New rule'}</h3>
          {onDelete && (
            <button onClick={async () => { if (await showConfirm('Delete rule?', { title: 'Delete rule', danger: true, confirmLabel: 'Delete' })) await onDelete() }}
              className="text-text-tertiary hover:text-red-400"><Trash2 size={14} /></button>
          )}
        </div>
        <div className="space-y-2 text-xs">
          <div className="flex gap-2">
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Label</div>
              <input value={label} onChange={(e) => setLabel(e.target.value)}
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
            </label>
            <label className="w-20">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Priority</div>
              <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)}
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
            </label>
          </div>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mt-2">Match (all conditions present must apply)</div>
          <label className="block">
            <div className="text-[10px] text-text-tertiary mb-0.5">Merchant contains</div>
            <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. tesco"
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
          </label>
          <label className="block">
            <div className="text-[10px] text-text-tertiary mb-0.5">Description contains</div>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
          </label>
          <label className="block">
            <div className="text-[10px] text-text-tertiary mb-0.5">Counterparty contains</div>
            <input value={counterparty} onChange={(e) => setCounterparty(e.target.value)}
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
          </label>
          <div className="flex gap-2">
            <label className="flex-1">
              <div className="text-[10px] text-text-tertiary mb-0.5">Amount sign</div>
              <select value={sign} onChange={(e) => setSign(e.target.value as '' | 'in' | 'out')}
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary">
                <option value="">Either</option>
                <option value="in">Income (positive)</option>
                <option value="out">Expense (negative)</option>
              </select>
            </label>
            <label className="flex-1">
              <div className="text-[10px] text-text-tertiary mb-0.5">Monzo category equals</div>
              <input value={monzoCat} onChange={(e) => setMonzoCat(e.target.value)} placeholder="e.g. groceries"
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
            </label>
          </div>
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mt-2">Action</div>
          <label className="block">
            <div className="text-[10px] text-text-tertiary mb-0.5">Apply category</div>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary">
              <option value="">Pick…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select>
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-2"><input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} />Mark as ignored</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={asTransfer} onChange={(e) => setAsTransfer(e.target.checked)} />Treat as transfer</label>
          </div>

          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mt-2">Shared expense</div>
          <div className="flex gap-2 items-end">
            <label className="w-32">
              <div className="text-[10px] text-text-tertiary mb-0.5">Your share (0..1)</div>
              <input value={sharedFraction} onChange={(e) => setSharedFraction(e.target.value)}
                type="number" step="0.05" min="0" max="1"
                placeholder="e.g. 0.5"
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
            </label>
            <label className="flex-1">
              <div className="text-[10px] text-text-tertiary mb-0.5">Counterparty</div>
              <input value={sharedCounterparty} onChange={(e) => setSharedCounterparty(e.target.value)}
                placeholder="e.g. Veronica Nacci"
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
            </label>
          </div>
          <p className="text-[10px] text-text-tertiary">0.5 = 50/50 split. The counterparty's name is matched against inbound transfer counterparties to net reimbursements off the shared-tab balance.</p>
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm">Cancel</button>
          <button
            disabled={!categoryId}
            onClick={() => onSave({
              id: rule?.id,
              priority: parseInt(priority, 10) || 50,
              label: label || undefined,
              match: {
                merchantContains: merchant || undefined,
                descriptionContains: description || undefined,
                counterpartyContains: counterparty || undefined,
                amountSign: sign || undefined,
                monzoCategoryEquals: monzoCat || undefined,
              },
              categoryId,
              ignore: ignore || undefined,
              asTransfer: asTransfer || undefined,
              sharedFraction: sharedFraction.trim() === '' ? undefined : Math.max(0, Math.min(1, parseFloat(sharedFraction))),
              sharedWithCounterparty: sharedCounterparty.trim() || undefined,
            })}
            className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm font-medium disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>
  )
}
