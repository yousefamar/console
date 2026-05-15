// TransactionsView — the original three-pane (sidebar / list / detail)
// experience for browsing and triaging Monzo transactions. Wired up to the
// new categorisation engine (rules + per-tx override) so categories shown
// here are the user's, not Monzo's defaults.

import { useRef, useState } from 'react'
import {
  Apple, ArrowDownCircle, ArrowUpCircle, Banknote, Circle, Clock, CreditCard,
  ExternalLink, Film, FileText, Info, Loader2, MapPin, MessageSquare,
  PoundSterling, Plane, Receipt, RefreshCw as Recurring, Search, ShoppingBag,
  Train, UtensilsCrossed, Users, X, Tag,
} from 'lucide-react'
import {
  useMoneyStore, formatAmount, formatAmountAbs, getDisplayName, getReference,
  getMerchantEmoji, MONZO_CATEGORIES, type MonzoTransaction, type MonzoPot,
} from '@/store/money'
import { useFinanceStore, fmtPence } from '@/store/finance'
import { hubFetch } from '@/hub'
import { MoneyScrollPane } from './MoneyScrollPane'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  general: <Circle size={12} />,
  eating_out: <UtensilsCrossed size={12} />,
  expenses: <Receipt size={12} />,
  transport: <Train size={12} />,
  cash: <Banknote size={12} />,
  bills: <FileText size={12} />,
  entertainment: <Film size={12} />,
  shopping: <ShoppingBag size={12} />,
  holidays: <Plane size={12} />,
  groceries: <Apple size={12} />,
}

export function TransactionsView({ isMobile }: { isMobile: boolean }) {
  const selectedTransactionId = useMoneyStore((s) => s.selectedTransactionId)

  if (isMobile) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {selectedTransactionId ? <TransactionDetail /> : <TransactionList />}
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-52 flex-shrink-0 border-r border-border overflow-y-auto">
        <Sidebar />
      </div>
      <div className="w-80 flex-shrink-0 border-r border-border overflow-hidden flex flex-col">
        <TransactionList />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <TransactionDetail />
      </div>
    </div>
  )
}

function Sidebar() {
  const balance = useMoneyStore((s) => s.balance)
  const pots = useMoneyStore((s) => s.pots)
  const categoryFilter = useMoneyStore((s) => s.categoryFilter)
  const setCategoryFilter = useMoneyStore((s) => s.setCategoryFilter)
  const syncing = useMoneyStore((s) => s.syncing)
  const monthly = useFinanceStore((s) => s.monthly)
  const categories = useFinanceStore((s) => s.categories)

  const currentMonth = new Date().toISOString().slice(0, 7)
  const thisMonth = monthly.find((m) => m.month === currentMonth)?.byCategory ?? {}
  const totalSpend = Object.values(thisMonth).filter((v) => v > 0).reduce((a, b) => a + b, 0)

  return (
    <div className="p-3 text-xs space-y-4">
      {balance && (
        <div>
          <div className="text-text-tertiary mb-1 uppercase tracking-wider text-[10px]">Monzo</div>
          <div className="text-lg font-medium text-text-primary">{formatAmountAbs(balance.balance)}</div>
          <div className="text-text-tertiary mt-0.5">Total: {formatAmountAbs(balance.total_balance)}</div>
        </div>
      )}

      {pots.length > 0 && (
        <div>
          <div className="text-text-tertiary mb-1.5 uppercase tracking-wider text-[10px]">Pots</div>
          <div className="space-y-1">
            {pots.map((pot) => <PotRow key={pot.id} pot={pot} />)}
          </div>
        </div>
      )}

      <div>
        <div className="text-text-tertiary mb-1.5 uppercase tracking-wider text-[10px]">Monzo categories</div>
        <div className="space-y-0.5">
          <button
            onClick={() => setCategoryFilter(null)}
            className={`w-full text-left px-1.5 py-1 rounded-sm flex items-center gap-1.5 transition-colors ${
              !categoryFilter ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-2'
            }`}
          >
            All
          </button>
          {Object.entries(MONZO_CATEGORIES).map(([key, { label }]) => (
            <button
              key={key}
              onClick={() => setCategoryFilter(categoryFilter === key ? null : key)}
              className={`w-full text-left px-1.5 py-1 rounded-sm flex items-center gap-1.5 transition-colors ${
                categoryFilter === key ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-2'
              }`}
            >
              {CATEGORY_ICONS[key]}
              <span className="truncate flex-1">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {totalSpend > 0 && categories.length > 0 && (
        <div>
          <div className="text-text-tertiary mb-1.5 uppercase tracking-wider text-[10px]">This month (your categories)</div>
          <div className="text-sm font-medium text-text-primary mb-2">{fmtPence(totalSpend, { abs: true })}</div>
          <div className="space-y-1">
            {Object.entries(thisMonth)
              .filter(([, v]) => v > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([catId, amount]) => {
                const cat = categories.find((c) => c.id === catId)
                const pct = (amount / totalSpend) * 100
                return (
                  <div key={catId} className="flex items-center gap-1.5">
                    <span className="w-20 truncate text-text-secondary">
                      {cat?.emoji} {cat?.name ?? catId}
                    </span>
                    <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: cat?.color ?? '#94a3b8' }} />
                    </div>
                    <span className="w-12 text-right text-text-tertiary tabular-nums">{pct.toFixed(0)}%</span>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {syncing && (
        <div className="flex items-center gap-1.5 text-text-tertiary">
          <Loader2 size={10} className="animate-spin" />
          Syncing…
        </div>
      )}
    </div>
  )
}

function PotRow({ pot }: { pot: MonzoPot }) {
  const [open, setOpen] = useState(false)
  const [amt, setAmt] = useState('')
  const depositToPot = useMoneyStore((s) => s.depositToPot)
  const withdrawFromPot = useMoneyStore((s) => s.withdrawFromPot)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-1.5 py-1 rounded-sm flex items-center justify-between hover:bg-surface-2"
      >
        <span className="truncate text-text-secondary">{pot.name}</span>
        <span className="text-text-primary font-medium">{formatAmountAbs(pot.balance)}</span>
      </button>
      {open && (
        <div className="px-1.5 py-1 flex gap-1 items-center">
          <input
            type="number"
            placeholder="£"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            className="w-16 px-1 py-0.5 text-[10px] bg-surface-2 border border-border rounded-sm text-text-primary"
            step="0.01"
          />
          <button onClick={() => depositToPot(pot.id, Math.round(parseFloat(amt) * 100)).then(() => setAmt(''))}
            className="p-0.5 text-text-tertiary hover:text-text-primary" title="Deposit">
            <ArrowDownCircle size={12} />
          </button>
          <button onClick={() => withdrawFromPot(pot.id, Math.round(parseFloat(amt) * 100)).then(() => setAmt(''))}
            className="p-0.5 text-text-tertiary hover:text-text-primary" title="Withdraw">
            <ArrowUpCircle size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

function TransactionList() {
  const transactions = useMoneyStore((s) => s.transactions)
  const selectedTransactionId = useMoneyStore((s) => s.selectedTransactionId)
  const selectTransaction = useMoneyStore((s) => s.selectTransaction)
  const searchQuery = useMoneyStore((s) => s.searchQuery)
  const setSearchQuery = useMoneyStore((s) => s.setSearchQuery)
  const searchRef = useRef<HTMLInputElement>(null)

  const groups = groupByDate(transactions)

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 px-2 py-1.5 border-b border-border">
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search transactions…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-money-search
            className="w-full pl-6 pr-6 py-1 text-xs bg-surface-2 border border-border rounded-sm text-text-primary placeholder:text-text-tertiary"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary">
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      <MoneyScrollPane className="flex-1 overflow-y-auto">
        {transactions.length === 0 && (
          <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
            {searchQuery ? 'No matching transactions' : 'No transactions'}
          </div>
        )}
        {groups.map(([date, txns]) => (
          <div key={date}>
            <div className="sticky top-0 bg-surface-0 px-3 py-1 text-[10px] text-text-tertiary uppercase tracking-wider border-b border-border">
              {formatDateGroup(date)}
            </div>
            {txns.map((tx) => (
              <TransactionRow key={tx.id} tx={tx}
                selected={tx.id === selectedTransactionId}
                onClick={() => selectTransaction(tx.id)}
              />
            ))}
          </div>
        ))}
      </MoneyScrollPane>
    </div>
  )
}

function TransactionRow({ tx, selected, onClick }: { tx: MonzoTransaction; selected: boolean; onClick: () => void }) {
  const emoji = getMerchantEmoji(tx)
  const name = getDisplayName(tx)
  const ref = getReference(tx)
  const isPending = !tx.settled
  const isDeclined = !!tx.decline_reason
  const cls = useFinanceStore((s) => s.classifications[tx.id])
  const cat = useFinanceStore((s) => cls ? s.categories.find((c) => c.id === cls.categoryId) : undefined)

  return (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-2 flex items-start gap-2 border-b border-border transition-colors ${
        selected ? 'bg-surface-2' : 'hover:bg-surface-1'
      } ${isDeclined || cls?.ignored || cls?.isTransfer ? 'opacity-50' : ''}`}>
      <span className="w-5 text-center flex-shrink-0 leading-[18px] text-xs">
        {emoji || (cat ? <span style={{ color: cat.color }}>{cat.emoji}</span> : CATEGORY_ICONS[tx.category] || <Circle size={12} />)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary truncate">{name}</div>
        {ref && <div className="text-[10px] text-text-tertiary truncate">{ref}</div>}
        {!ref && cat && <div className="text-[10px] text-text-tertiary truncate">{cat.name}</div>}
        {isPending && !isDeclined && !ref && !cat && <div className="text-[10px] text-text-tertiary">Pending</div>}
        {isDeclined && <div className="text-[10px] text-red-400">Declined</div>}
      </div>
      <div className={`text-xs font-medium flex-shrink-0 ${tx.amount < 0 ? 'text-text-primary' : 'text-green-400'}`}>
        {tx.amount < 0 ? `-${formatAmountAbs(tx.amount)}` : `+${formatAmountAbs(tx.amount)}`}
      </div>
    </button>
  )
}

function TransactionDetail() {
  const transactions = useMoneyStore((s) => s.transactions)
  const selectedTransactionId = useMoneyStore((s) => s.selectedTransactionId)
  const annotateTransaction = useMoneyStore((s) => s.annotateTransaction)
  const categories = useFinanceStore((s) => s.categories)
  const cls = useFinanceStore((s) => selectedTransactionId ? s.classifications[selectedTransactionId] : undefined)
  const setOverride = useFinanceStore((s) => s.setOverride)
  const clearOverride = useFinanceStore((s) => s.clearOverride)

  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [picking, setPicking] = useState(false)
  const notesRef = useRef<HTMLInputElement>(null)

  const tx = transactions.find((t) => t.id === selectedTransactionId)
  if (!tx) {
    return <div className="flex flex-1 items-center justify-center text-xs text-text-tertiary">Select a transaction</div>
  }

  const merchant = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant : null
  const counterparty = tx.counterparty?.name ? tx.counterparty : null
  const isPending = !tx.settled
  const displayName = getDisplayName(tx)
  const reference = getReference(tx)
  const scheme = tx.scheme ?? ''
  const schemeLabel = scheme === 'mastercard' ? 'Card'
    : scheme === 'payport_faster_payments' ? 'Faster payment'
    : scheme === 'bacs' ? 'Direct debit'
    : scheme === 'monzo_to_monzo' ? 'Monzo'
    : null
  const address = merchant?.address
  const hasLocation = address && !address.approximate && address.address
  const website = (merchant?.metadata as Record<string, string> | undefined)?.website
  const tab = tx.tab
  const atmFees = tx.atm_fees_detailed
  const isSubscription = !!tx.metadata?.subscription_id

  const userCat = cls ? categories.find((c) => c.id === cls.categoryId) : undefined
  const isIgnored = !!cls?.ignored
  const isTransfer = !!cls?.isTransfer

  const startEditNotes = () => {
    setNotes(tx.notes || '')
    setEditingNotes(true)
    setTimeout(() => notesRef.current?.focus(), 50)
  }
  const saveNotes = async () => {
    await annotateTransaction(tx.id, 'notes', notes)
    setEditingNotes(false)
  }

  return (
    <div className="p-4 overflow-y-auto">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5 min-w-0">
          {merchant?.logo ? (
            <img src={merchant.logo} alt="" className="w-9 h-9 rounded-sm flex-shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : merchant?.emoji ? (
            <span className="text-2xl flex-shrink-0 w-9 text-center">{merchant.emoji}</span>
          ) : null}
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-text-primary truncate">{displayName}</h2>
            {reference && <div className="text-[11px] text-text-tertiary truncate">{reference}</div>}
          </div>
        </div>
        <div className={`text-lg font-medium flex-shrink-0 tabular-nums ${tx.amount < 0 ? 'text-text-primary' : 'text-green-400'}`}>
          {formatAmount(tx.amount)}
        </div>
      </div>

      <div className="space-y-3">
        <DetailBlock icon={<Clock size={13} />}>
          <span className="text-text-secondary">
            {new Date(tx.created).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            {' at '}{new Date(tx.created).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className={`text-[10px] ${isPending ? 'text-yellow-400' : tx.decline_reason ? 'text-red-400' : 'text-text-tertiary'}`}>
            {isPending ? 'Pending' : tx.decline_reason ? `Declined — ${tx.decline_reason}`
              : `Settled ${new Date(tx.settled).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
          </span>
        </DetailBlock>

        <DetailBlock icon={<Tag size={13} />}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setPicking(!picking)}
              className="text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1.5"
            >
              {userCat ? <><span>{userCat.emoji}</span><span>{userCat.name}</span></> : <span className="text-text-tertiary">Set category</span>}
              {schemeLabel && <span className="text-text-tertiary">· {schemeLabel}</span>}
              {isSubscription && <Recurring size={10} className="text-text-tertiary" />}
            </button>
            {(isIgnored || isTransfer) && (
              <span className="text-[10px] text-text-tertiary">{isIgnored ? '(ignored)' : '(transfer)'}</span>
            )}
          </div>
          {picking && (
            <div className="mt-2 grid grid-cols-2 gap-1">
              {categories.filter((c) => !c.archived).map((c) => (
                <button key={c.id}
                  onClick={async () => { await setOverride({ txId: tx.id, categoryId: c.id, ignore: false }); setPicking(false) }}
                  className={`text-left px-2 py-1 text-[11px] rounded-sm hover:bg-surface-2 ${userCat?.id === c.id ? 'bg-surface-2' : ''}`}
                >
                  <span className="mr-1">{c.emoji}</span>{c.name}
                </button>
              ))}
              <button onClick={async () => { await setOverride({ txId: tx.id, ignore: true }); setPicking(false) }}
                className="text-left px-2 py-1 text-[11px] rounded-sm hover:bg-surface-2 text-text-tertiary col-span-2">
                Ignore (don't count toward spend)
              </button>
              <button onClick={async () => { await clearOverride(tx.id); setPicking(false) }}
                className="text-left px-2 py-1 text-[11px] rounded-sm hover:bg-surface-2 text-text-tertiary col-span-2">
                Clear override
              </button>
            </div>
          )}
        </DetailBlock>

        {hasLocation && (
          <DetailBlock icon={<MapPin size={13} />}>
            <span className="text-text-secondary">
              {[address.address, address.city, address.postcode].filter(Boolean).join(', ')}
            </span>
          </DetailBlock>
        )}

        {counterparty && (
          <DetailBlock icon={<Users size={13} />}>
            <span className="text-text-secondary">{counterparty.preferred_name || counterparty.name}</span>
            {counterparty.sort_code && counterparty.account_number && (
              <span className="text-[10px] text-text-tertiary font-mono">
                {counterparty.sort_code.replace(/(..)(..)(..)/, '$1-$2-$3')} · {counterparty.account_number}
              </span>
            )}
          </DetailBlock>
        )}

        {tx.local_currency && tx.local_currency !== tx.currency && (
          <DetailBlock icon={<PoundSterling size={13} />}>
            <span className="text-text-secondary">
              {(Math.abs(tx.local_amount ?? tx.amount) / 100).toFixed(2)} {tx.local_currency}
            </span>
          </DetailBlock>
        )}

        {tab && (
          <DetailBlock icon={<Users size={13} />}>
            <span className="text-text-secondary">{tab.name}</span>
            <span className="text-[10px] text-text-tertiary">
              {tab.participants.map((p) => p.first_name || p.name).join(' & ')} · {tab.item_count} items
            </span>
          </DetailBlock>
        )}

        {atmFees?.allowance_usage_explainer_text && (
          <DetailBlock icon={<Info size={13} />}>
            <span className="text-[11px] text-text-tertiary">{atmFees.allowance_usage_explainer_text}</span>
          </DetailBlock>
        )}

        <DetailBlock icon={<MessageSquare size={13} />}>
          {editingNotes ? (
            <div className="flex gap-1 w-full">
              <input ref={notesRef} type="text" value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveNotes(); if (e.key === 'Escape') setEditingNotes(false) }}
                className="flex-1 px-2 py-0.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary" />
              <button onClick={saveNotes}
                className="px-2 py-0.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary hover:bg-surface-1">
                Save
              </button>
            </div>
          ) : (
            <button onClick={startEditNotes} className="text-left text-text-secondary hover:text-text-primary transition-colors">
              {tx.notes || <span className="text-text-tertiary">Add a note…</span>}
            </button>
          )}
        </DetailBlock>

        {website && (
          <DetailBlock icon={<ExternalLink size={13} />}>
            <a href={website.startsWith('http') ? website : `https://${website}`}
              target="_blank" rel="noreferrer"
              className="text-text-tertiary hover:text-text-secondary transition-colors text-[11px]">
              {website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
          </DetailBlock>
        )}

        <DetailBlock icon={<CreditCard size={13} />}>
          <button
            onClick={async () => {
              const merchantName = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant.name : ''
              const counterpartyName = tx.counterparty?.name ?? ''
              const match = merchantName ? { merchantContains: merchantName }
                : counterpartyName ? { counterpartyContains: counterpartyName }
                : { descriptionContains: tx.description }
              const catId = userCat?.id ?? cls?.categoryId ?? 'cat_uncat'
              await hubFetch('/finance/rules', {
                method: 'POST',
                body: JSON.stringify({ priority: 50, label: `From: ${displayName}`, match, categoryId: catId }),
              })
              await useFinanceStore.getState().fetchAll()
            }}
            className="text-text-tertiary hover:text-text-secondary text-[11px] text-left"
          >
            Make a rule from this transaction
          </button>
        </DetailBlock>
      </div>

      <div className="mt-4 pt-3 border-t border-border">
        <button onClick={() => setShowRaw(!showRaw)}
          className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1">
          <Info size={10} />{showRaw ? 'Hide raw data' : 'Raw data'}
        </button>
        {showRaw && (
          <pre className="mt-2 p-2 bg-surface-2 rounded-sm border border-border text-[10px] text-text-tertiary font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-96 overflow-y-auto">
            {JSON.stringify(tx, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}

function DetailBlock({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 items-start">
      <span className="text-text-tertiary mt-0.5 flex-shrink-0 w-4">{icon}</span>
      <div className="flex-1 min-w-0 flex flex-col text-xs">{children}</div>
    </div>
  )
}

function groupByDate(transactions: MonzoTransaction[]): [string, MonzoTransaction[]][] {
  const groups = new Map<string, MonzoTransaction[]>()
  for (const tx of transactions) {
    const date = tx.created.slice(0, 10)
    const group = groups.get(date)
    if (group) group.push(tx)
    else groups.set(date, [tx])
  }
  return Array.from(groups.entries())
}

function formatDateGroup(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  if (dateStr === today.toISOString().slice(0, 10)) return 'Today'
  if (dateStr === yesterday.toISOString().slice(0, 10)) return 'Yesterday'
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}
