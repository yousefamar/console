// NetWorthView — accounts list + net worth history chart + per-account ledger
// editor for manual accounts. The Monzo current account auto-syncs; everything
// else (Lloyds, Revolut, S&S ISAs, GIAs, Veronica's holding) is a manual
// account with a balance ledger you update whenever you check.

import { useState } from 'react'
import { Plus, Trash2, ChevronRight, ChevronDown } from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Brush,
} from 'recharts'
import { useFinanceStore, fmtPence, fmtMonth, type Account } from '@/store/finance'

export function NetWorthView() {
  const accounts = useFinanceStore((s) => s.accounts)
  const netWorth = useFinanceStore((s) => s.netWorth)
  const history = useFinanceStore((s) => s.netWorthHistory)
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [openLedger, setOpenLedger] = useState<string | null>(null)

  const liquid = accounts.filter((a) => a.liquidity === 'liquid' && !a.archived)
  const investment = accounts.filter((a) => a.liquidity === 'investment' && !a.archived)
  const illiquid = accounts.filter((a) => a.liquidity === 'illiquid' && !a.archived)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Headline */}
      <div className="border-b border-border p-4">
        <div className="grid grid-cols-3 gap-3">
          <Tile label="Liquid" value={fmtPence(netWorth?.liquidPence ?? 0, { abs: true })} colour="#3b82f6" />
          <Tile label="Investments" value={fmtPence(netWorth?.investmentPence ?? 0, { abs: true })} colour="#a78bfa" />
          <Tile label="Total net worth" value={fmtPence(netWorth?.totalPence ?? 0, { abs: true })} colour="text-text-primary" emphasise />
        </div>
      </div>

      {/* History chart */}
      <div className="border-b border-border py-3">
        <div className="px-4 flex items-center justify-between mb-2">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Net worth — last 12 mo</h3>
        </div>
        {history.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-text-tertiary">No history yet — add balance entries.</div>
        ) : (
          <div style={{ width: '100%', height: 200 }} className="px-2">
            <ResponsiveContainer>
              <AreaChart data={history.map((h) => ({
                month: h.date.slice(0, 7),
                liquid: h.liquidPence / 100,
                investment: h.investmentPence / 100,
              }))} margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="liq" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="inv" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="month" tickFormatter={fmtMonth} fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
                <YAxis fontSize={10} stroke="var(--color-text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--color-border)' }}
                  tickFormatter={(v) => fmtPence(Math.round((v as number) * 100), { abs: true })} width={55} />
                <Tooltip
                  contentStyle={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-border)', fontSize: 11, borderRadius: 4 }}
                  labelStyle={{ color: 'var(--color-text-secondary)' }}
                  formatter={((v: unknown, k: unknown) => [fmtPence(Math.round((v as number) * 100), { abs: true }), k === 'liquid' ? 'Liquid' : 'Investments']) as never}
                  labelFormatter={((m: unknown) => fmtMonth(m as string)) as never}
                />
                <Area type="monotone" dataKey="investment" stackId="1" stroke="#a78bfa" fill="url(#inv)" />
                <Area type="monotone" dataKey="liquid" stackId="1" stroke="#3b82f6" fill="url(#liq)" />
                <Brush dataKey="month" height={20} stroke="var(--color-border)"
                  fill="var(--color-surface-1)" travellerWidth={8} tickFormatter={fmtMonth as never} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Accounts */}
      <div className="py-3">
        <div className="px-4 flex items-center justify-between mb-2">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Accounts</h3>
          <button onClick={() => setEditing('new')} className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary">
            <Plus size={12} />Add account
          </button>
        </div>

        <Section title="Liquid (cash, current accounts)" rows={liquid} setEditing={setEditing} openLedger={openLedger} setOpenLedger={setOpenLedger} netWorth={netWorth} />
        <Section title="Investments (ISAs, GIAs)" rows={investment} setEditing={setEditing} openLedger={openLedger} setOpenLedger={setOpenLedger} netWorth={netWorth} />
        <Section title="Illiquid / external" rows={illiquid} setEditing={setEditing} openLedger={openLedger} setOpenLedger={setOpenLedger} netWorth={netWorth} />
      </div>

      {editing && <AccountEditor account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Tile({ label, value, colour, emphasise }: { label: string; value: string; colour: string; emphasise?: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="w-2 h-2 rounded-full" style={{ background: colour.startsWith('#') ? colour : undefined }} />
        <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      </div>
      <div className={`tabular-nums ${emphasise ? 'text-2xl font-medium text-text-primary' : 'text-lg text-text-primary'}`}>{value}</div>
    </div>
  )
}

function Section({
  title, rows, setEditing, openLedger, setOpenLedger, netWorth,
}: {
  title: string; rows: Account[];
  setEditing: (a: Account) => void;
  openLedger: string | null;
  setOpenLedger: (id: string | null) => void;
  netWorth: ReturnType<typeof useFinanceStore.getState>['netWorth'];
}) {
  if (rows.length === 0) return null
  return (
    <div className="px-4 mb-4">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">{title}</div>
      <div className="space-y-1">
        {rows.map((acc) => {
          const bal = netWorth?.byAccount.find((b) => b.accountId === acc.id)?.balancePence ?? 0
          return (
            <div key={acc.id} className="border border-border rounded-sm">
              <div className="flex items-center gap-2 px-2 py-1.5">
                {acc.type === 'manual' ? (
                  <button onClick={() => setOpenLedger(openLedger === acc.id ? null : acc.id)}
                    className="text-text-tertiary hover:text-text-primary">
                    {openLedger === acc.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                ) : <span className="w-3" />}
                <span className="w-5 text-center">{acc.emoji ?? (acc.type === 'monzo' ? '🟧' : '💳')}</span>
                <button onClick={() => setEditing(acc)} className="flex-1 text-left text-xs text-text-primary truncate">
                  {acc.name}
                  {acc.isExternal && <span className="text-text-tertiary ml-1.5 text-[10px]">(held externally)</span>}
                </button>
                <div className="text-xs tabular-nums text-text-primary">{fmtPence(bal, { abs: true })}</div>
              </div>
              {openLedger === acc.id && acc.type === 'manual' && <Ledger account={acc} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Ledger({ account }: { account: Account }) {
  const addBalanceEntry = useFinanceStore((s) => s.addBalanceEntry)
  const deleteBalanceEntry = useFinanceStore((s) => s.deleteBalanceEntry)
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [pounds, setPounds] = useState('')
  const [note, setNote] = useState('')

  const entries = (account.ledger ?? []).slice().sort((a, b) => b.date.localeCompare(a.date))

  const add = async () => {
    const balancePence = Math.round(parseFloat(pounds) * 100)
    if (!Number.isFinite(balancePence)) return
    await addBalanceEntry(account.id, { date, balancePence, note: note || undefined })
    setPounds(''); setNote('')
  }

  return (
    <div className="border-t border-border bg-surface-1 px-3 py-2">
      <div className="flex gap-2 items-end mb-2 text-xs">
        <label className="flex-shrink-0">
          <div className="text-[10px] text-text-tertiary mb-0.5">Date</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5" />
        </label>
        <label className="flex-1 min-w-0">
          <div className="text-[10px] text-text-tertiary mb-0.5">Balance (£)</div>
          <input type="number" value={pounds} onChange={(e) => setPounds(e.target.value)} placeholder="0.00"
            className="w-full bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5" />
        </label>
        <label className="flex-1 min-w-0">
          <div className="text-[10px] text-text-tertiary mb-0.5">Note (optional)</div>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            className="w-full bg-surface-2 border border-border rounded-sm text-text-primary px-1 py-0.5" />
        </label>
        <button onClick={add} className="px-2 py-1 text-xs bg-surface-2 border border-border rounded-sm">Add entry</button>
      </div>

      {entries.length === 0 ? (
        <div className="text-xs text-text-tertiary py-1">No entries yet — add today's balance to start.</div>
      ) : (
        <div className="space-y-0.5">
          {entries.map((e) => (
            <div key={e.id} className="flex items-center gap-2 text-xs">
              <span className="text-text-tertiary w-24 tabular-nums">{e.date}</span>
              <span className="text-text-primary tabular-nums w-24">{fmtPence(e.balancePence, { abs: true })}</span>
              <span className="text-text-tertiary truncate flex-1">{e.note}</span>
              <button onClick={() => deleteBalanceEntry(account.id, e.id)} className="text-text-tertiary hover:text-red-400">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AccountEditor({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const upsertAccount = useFinanceStore((s) => s.upsertAccount)
  const deleteAccount = useFinanceStore((s) => s.deleteAccount)

  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<Account['type']>(account?.type ?? 'manual')
  const [liquidity, setLiquidity] = useState<Account['liquidity']>(account?.liquidity ?? 'liquid')
  const [emoji, setEmoji] = useState(account?.emoji ?? '')
  const [isExternal, setIsExternal] = useState(account?.isExternal ?? false)
  const [notes, setNotes] = useState(account?.notes ?? '')
  const [growth, setGrowth] = useState(account?.growthPctYoy != null ? account.growthPctYoy.toString() : '')

  const save = async () => {
    if (!name) return
    await upsertAccount({
      id: account?.id,
      name, type, liquidity,
      currency: 'GBP',
      emoji: emoji || undefined,
      isExternal,
      notes: notes || undefined,
      growthPctYoy: growth.trim() === '' ? undefined : parseFloat(growth),
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface-0 border border-border rounded-md p-4 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">{account ? 'Edit account' : 'New account'}</h3>
          {account && (
            <button onClick={async () => { if (confirm('Delete account? Balance history is lost.')) { await deleteAccount(account.id); onClose() } }}
              className="text-text-tertiary hover:text-red-400">
              <Trash2 size={14} />
            </button>
          )}
        </div>

        <div className="space-y-2 text-xs">
          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Name</div>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lloyds Current"
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
          </label>

          <div className="flex gap-2">
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Type</div>
              <select value={type} onChange={(e) => setType(e.target.value as Account['type'])}
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary">
                <option value="manual">Manual (track balance updates)</option>
                <option value="monzo">Monzo (auto-sync)</option>
              </select>
            </label>
            <label className="flex-1">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Liquidity</div>
              <select value={liquidity} onChange={(e) => setLiquidity(e.target.value as Account['liquidity'])}
                className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary">
                <option value="liquid">Liquid (counts toward runway)</option>
                <option value="investment">Investment</option>
                <option value="illiquid">Illiquid (info only)</option>
              </select>
            </label>
          </div>

          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Emoji</div>
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)}
              placeholder="🏦"
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
          </label>

          <label className="flex items-center gap-2 mt-2">
            <input type="checkbox" checked={isExternal} onChange={(e) => setIsExternal(e.target.checked)} />
            <span>Held externally (e.g. someone else holds it for you)</span>
          </label>

          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Annual growth %</div>
            <input value={growth} onChange={(e) => setGrowth(e.target.value)}
              type="number" step="0.05"
              placeholder="e.g. 6.5 for equity fund, 3.25 for savings"
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary" />
            <div className="text-[10px] text-text-tertiary mt-0.5">Leave blank to use the global default. Liquid current accounts usually 0%.</div>
          </label>

          <label className="block">
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">Notes</div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full px-2 py-1 bg-surface-2 border border-border rounded-sm text-text-primary"
              rows={2} />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm">Cancel</button>
          <button onClick={save} className="px-3 py-1 text-xs bg-surface-2 border border-border rounded-sm font-medium">Save</button>
        </div>
      </div>
    </div>
  )
}
