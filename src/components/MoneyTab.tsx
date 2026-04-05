import { useEffect, useRef, useState } from 'react'
import { useMoneyStore, formatAmount, formatAmountAbs, getDisplayName, getReference, getMerchantEmoji, MONZO_CATEGORIES } from '@/store/money'
import type { MonzoTransaction, MonzoPot } from '@/store/money'
import { useIsMobile } from '@/hooks/useMediaQuery'
import {
  PoundSterling, Circle, UtensilsCrossed, Receipt, Train, Banknote,
  FileText, Film, ShoppingBag, Plane, Apple, Loader2, ArrowUpCircle,
  ArrowDownCircle, Search, X, Clock, MapPin, CreditCard, Users,
  MessageSquare, ExternalLink, RefreshCw as Recurring, Info,
} from 'lucide-react'

// --------------------------------------------------------------------------
// Category icon mapping
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// MoneyTab
// --------------------------------------------------------------------------

export function MoneyTab() {
  const status = useMoneyStore((s) => s.status)
  const loading = useMoneyStore((s) => s.loading)
  const fetchStatus = useMoneyStore((s) => s.fetchStatus)
  const fetchAll = useMoneyStore((s) => s.fetchAll)
  const selectedTransactionId = useMoneyStore((s) => s.selectedTransactionId)
  const isMobile = useIsMobile()

  useEffect(() => {
    fetchStatus().then(() => {
      const st = useMoneyStore.getState().status
      if (st?.connected) {
        fetchAll()
      }
    })
  }, [])

  // Not connected
  if (status && !status.connected) {
    return <MoneyConnect hasCredentials={status.hasCredentials} />
  }

  // Loading
  if (loading && !useMoneyStore.getState().transactions.length) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
        <span className="text-xs text-text-tertiary ml-2">Loading transactions...</span>
      </div>
    )
  }

  if (isMobile) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {selectedTransactionId ? <MoneyTransactionDetail /> : <MoneyTransactionList />}
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-52 flex-shrink-0 border-r border-border overflow-y-auto">
        <MoneySidebar />
      </div>
      <div className="w-80 flex-shrink-0 border-r border-border overflow-hidden flex flex-col">
        <MoneyTransactionList />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <MoneyTransactionDetail />
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// MoneyConnect — connection screen
// --------------------------------------------------------------------------

function MoneyConnect({ hasCredentials }: { hasCredentials: boolean }) {
  const [settingUp, setSettingUp] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  const hubUrl = localStorage.getItem('console_hub_url') || 'http://localhost:9877'

  const saveCredentials = async () => {
    await fetch(`${hubUrl}/auth/monzo/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    })
    await useMoneyStore.getState().fetchStatus()
  }

  const startAuth = () => {
    window.open(`${hubUrl}/auth/monzo/start`, '_blank')
    // Poll for connection
    const poll = setInterval(async () => {
      await useMoneyStore.getState().fetchStatus()
      const st = useMoneyStore.getState().status
      if (st?.connected) {
        clearInterval(poll)
        // Trigger initial sync
        await useMoneyStore.getState().refreshSync()
      }
    }, 3000)
  }

  if (!hasCredentials && !settingUp) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <PoundSterling size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">Connect Monzo</p>
        <p className="text-xs text-text-tertiary max-w-xs">
          Link your Monzo account to view transactions, manage pots, and track spending.
        </p>
        <button
          onClick={() => setSettingUp(true)}
          className="mt-1 px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border transition-colors"
        >
          Set Up Monzo
        </button>
      </div>
    )
  }

  if (!hasCredentials && settingUp) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center px-4 max-w-sm mx-auto">
        <PoundSterling size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">Monzo API Credentials</p>
        <p className="text-xs text-text-tertiary">
          Enter your Monzo OAuth client credentials from{' '}
          <a href="https://developers.monzo.com" target="_blank" rel="noreferrer" className="underline">
            developers.monzo.com
          </a>
        </p>
        <input
          type="text"
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary"
        />
        <input
          type="password"
          placeholder="Client Secret"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary"
        />
        <div className="flex gap-2">
          <button
            onClick={() => setSettingUp(false)}
            className="px-3 py-1.5 text-xs bg-surface-2 text-text-secondary rounded-sm border border-border hover:bg-surface-1"
          >
            Cancel
          </button>
          <button
            onClick={saveCredentials}
            disabled={!clientId || !clientSecret}
            className="px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm border border-border hover:bg-surface-1 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    )
  }

  // Has credentials but not connected — start OAuth
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
      <PoundSterling size={24} className="text-text-tertiary" />
      <p className="text-sm text-text-secondary">Connect Monzo</p>
      <p className="text-xs text-text-tertiary max-w-xs">
        Authorize Console to access your Monzo account. You'll need to approve in the Monzo app.
      </p>
      <button
        onClick={startAuth}
        className="mt-1 px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border transition-colors"
      >
        Connect Monzo
      </button>
    </div>
  )
}

// --------------------------------------------------------------------------
// MoneySidebar — balance, pots, categories, spending
// --------------------------------------------------------------------------

function MoneySidebar() {
  const balance = useMoneyStore((s) => s.balance)
  const pots = useMoneyStore((s) => s.pots)
  const spendingByCategory = useMoneyStore((s) => s.spendingByCategory)
  const categoryFilter = useMoneyStore((s) => s.categoryFilter)
  const setCategoryFilter = useMoneyStore((s) => s.setCategoryFilter)
  const syncing = useMoneyStore((s) => s.syncing)

  const totalSpending = Object.values(spendingByCategory).reduce((a, b) => a + b, 0)

  return (
    <div className="p-3 text-xs space-y-4">
      {/* Balance */}
      {balance && (
        <div>
          <div className="text-text-tertiary mb-1 uppercase tracking-wider text-[10px]">Balance</div>
          <div className="text-lg font-medium text-text-primary">{formatAmountAbs(balance.balance)}</div>
          <div className="text-text-tertiary mt-0.5">
            Total (incl. pots): {formatAmountAbs(balance.total_balance)}
          </div>
          {balance.spend_today !== 0 && (
            <div className="text-text-tertiary">
              Today: {formatAmountAbs(Math.abs(balance.spend_today))}
            </div>
          )}
        </div>
      )}

      {/* Pots */}
      {pots.length > 0 && (
        <div>
          <div className="text-text-tertiary mb-1.5 uppercase tracking-wider text-[10px]">Pots</div>
          <div className="space-y-1">
            {pots.map((pot) => (
              <PotRow key={pot.id} pot={pot} />
            ))}
          </div>
        </div>
      )}

      {/* Category filters */}
      <div>
        <div className="text-text-tertiary mb-1.5 uppercase tracking-wider text-[10px]">Categories</div>
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
              {spendingByCategory[key] && (
                <span className="text-text-tertiary">{formatAmountAbs(spendingByCategory[key]!)}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Spending breakdown */}
      {totalSpending > 0 && (
        <div>
          <div className="text-text-tertiary mb-1.5 uppercase tracking-wider text-[10px]">
            This Month
          </div>
          <div className="text-sm font-medium text-text-primary mb-2">
            {formatAmountAbs(totalSpending)}
          </div>
          <div className="space-y-1">
            {Object.entries(spendingByCategory)
              .sort(([, a], [, b]) => b - a)
              .map(([cat, amount]) => {
                const pct = (amount / totalSpending) * 100
                const label = MONZO_CATEGORIES[cat]?.label ?? cat
                return (
                  <div key={cat} className="flex items-center gap-1.5">
                    <span className="w-16 truncate text-text-secondary">{label}</span>
                    <div className="flex-1 h-1.5 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-text-tertiary rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-text-tertiary">{pct.toFixed(0)}%</span>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {syncing && (
        <div className="flex items-center gap-1.5 text-text-tertiary">
          <Loader2 size={10} className="animate-spin" />
          Syncing...
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// PotRow
// --------------------------------------------------------------------------

function PotRow({ pot }: { pot: MonzoPot }) {
  const [showActions, setShowActions] = useState(false)
  const [amount, setAmount] = useState('')
  const depositToPot = useMoneyStore((s) => s.depositToPot)
  const withdrawFromPot = useMoneyStore((s) => s.withdrawFromPot)

  const handleDeposit = async () => {
    const pence = Math.round(parseFloat(amount) * 100)
    if (pence > 0) {
      await depositToPot(pot.id, pence)
      setAmount('')
      setShowActions(false)
    }
  }

  const handleWithdraw = async () => {
    const pence = Math.round(parseFloat(amount) * 100)
    if (pence > 0) {
      await withdrawFromPot(pot.id, pence)
      setAmount('')
      setShowActions(false)
    }
  }

  return (
    <div>
      <button
        onClick={() => setShowActions(!showActions)}
        className="w-full text-left px-1.5 py-1 rounded-sm flex items-center justify-between hover:bg-surface-2 transition-colors"
      >
        <span className="truncate text-text-secondary">{pot.name}</span>
        <span className="text-text-primary font-medium">{formatAmountAbs(pot.balance)}</span>
      </button>
      {showActions && (
        <div className="px-1.5 py-1 flex gap-1 items-center">
          <input
            type="number"
            placeholder="£"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-16 px-1 py-0.5 text-[10px] bg-surface-2 border border-border rounded-sm text-text-primary"
            step="0.01"
          />
          <button
            onClick={handleDeposit}
            className="p-0.5 text-text-tertiary hover:text-text-primary"
            title="Deposit"
          >
            <ArrowDownCircle size={12} />
          </button>
          <button
            onClick={handleWithdraw}
            className="p-0.5 text-text-tertiary hover:text-text-primary"
            title="Withdraw"
          >
            <ArrowUpCircle size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// MoneyTransactionList
// --------------------------------------------------------------------------

function MoneyTransactionList() {
  const transactions = useMoneyStore((s) => s.transactions)
  const selectedTransactionId = useMoneyStore((s) => s.selectedTransactionId)
  const selectTransaction = useMoneyStore((s) => s.selectTransaction)
  const searchQuery = useMoneyStore((s) => s.searchQuery)
  const setSearchQuery = useMoneyStore((s) => s.setSearchQuery)
  const searchRef = useRef<HTMLInputElement>(null)

  // Group transactions by date
  const groups = groupByDate(transactions)

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="flex-shrink-0 px-2 py-1.5 border-b border-border">
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search transactions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-money-search
            className="w-full pl-6 pr-6 py-1 text-xs bg-surface-2 border border-border rounded-sm text-text-primary placeholder:text-text-tertiary"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Transaction list */}
      <div className="flex-1 overflow-y-auto">
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
              <TransactionRow
                key={tx.id}
                tx={tx}
                selected={tx.id === selectedTransactionId}
                onClick={() => selectTransaction(tx.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// TransactionRow
// --------------------------------------------------------------------------

function TransactionRow({
  tx,
  selected,
  onClick,
}: {
  tx: MonzoTransaction
  selected: boolean
  onClick: () => void
}) {
  const emoji = getMerchantEmoji(tx)
  const name = getDisplayName(tx)
  const ref = getReference(tx)
  const isPending = !tx.settled
  const isDeclined = !!tx.decline_reason

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 flex items-start gap-2 border-b border-border transition-colors ${
        selected ? 'bg-surface-2' : 'hover:bg-surface-1'
      } ${isDeclined ? 'opacity-50' : ''}`}
    >
      {/* Emoji / category icon — aligned to first line of text */}
      <span className="w-5 text-center flex-shrink-0 leading-[18px] text-xs">
        {emoji || CATEGORY_ICONS[tx.category] || <Circle size={12} />}
      </span>

      {/* Name + reference */}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary truncate">{name}</div>
        {ref && <div className="text-[10px] text-text-tertiary truncate">{ref}</div>}
        {isPending && !isDeclined && !ref && (
          <div className="text-[10px] text-text-tertiary">Pending</div>
        )}
        {isDeclined && (
          <div className="text-[10px] text-red-400">Declined</div>
        )}
      </div>

      {/* Amount */}
      <div className={`text-xs font-medium flex-shrink-0 ${
        tx.amount < 0 ? 'text-text-primary' : 'text-green-400'
      }`}>
        {tx.amount < 0 ? `-${formatAmountAbs(tx.amount)}` : `+${formatAmountAbs(tx.amount)}`}
      </div>
    </button>
  )
}

// --------------------------------------------------------------------------
// MoneyTransactionDetail — semantic block layout
// --------------------------------------------------------------------------

function MoneyTransactionDetail() {
  const transactions = useMoneyStore((s) => s.transactions)
  const selectedTransactionId = useMoneyStore((s) => s.selectedTransactionId)
  const annotateTransaction = useMoneyStore((s) => s.annotateTransaction)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const notesRef = useRef<HTMLInputElement>(null)

  const tx = transactions.find((t) => t.id === selectedTransactionId)

  if (!tx) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-text-tertiary">
        Select a transaction
      </div>
    )
  }

  const merchant = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant : null
  const counterparty = tx.counterparty?.name ? tx.counterparty : null
  const isPending = !tx.settled
  const displayName = getDisplayName(tx)
  const reference = getReference(tx)
  const category = MONZO_CATEGORIES[tx.category]
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
      {/* Header: logo + name + amount */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5 min-w-0">
          {merchant?.logo ? (
            <img
              src={merchant.logo}
              alt=""
              className="w-9 h-9 rounded-sm flex-shrink-0"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : merchant?.emoji ? (
            <span className="text-2xl flex-shrink-0 w-9 text-center">{merchant.emoji}</span>
          ) : null}
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-text-primary truncate">{displayName}</h2>
            {reference && (
              <div className="text-[11px] text-text-tertiary truncate">{reference}</div>
            )}
          </div>
        </div>
        <div className={`text-lg font-medium flex-shrink-0 tabular-nums ${
          tx.amount < 0 ? 'text-text-primary' : 'text-green-400'
        }`}>
          {formatAmount(tx.amount)}
        </div>
      </div>

      {/* Semantic content blocks */}
      <div className="space-y-3">
        {/* Time + settled status */}
        <DetailBlock icon={<Clock size={13} />}>
          <span className="text-text-secondary">
            {new Date(tx.created).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            {' at '}
            {new Date(tx.created).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className={`text-[10px] ${
            isPending ? 'text-yellow-400' : tx.decline_reason ? 'text-red-400' : 'text-text-tertiary'
          }`}>
            {isPending ? 'Pending'
              : tx.decline_reason ? `Declined — ${tx.decline_reason}`
              : `Settled ${new Date(tx.settled).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
          </span>
        </DetailBlock>

        {/* Category + payment method */}
        <DetailBlock icon={category ? CATEGORY_ICONS[tx.category] ?? <Circle size={13} /> : <CreditCard size={13} />}>
          <span className="text-text-secondary flex items-center gap-1.5">
            {category?.label ?? tx.category}
            {schemeLabel && <span className="text-text-tertiary">· {schemeLabel}</span>}
            {isSubscription && <Recurring size={10} className="text-text-tertiary" />}
          </span>
        </DetailBlock>

        {/* Location (card transactions with real address) */}
        {hasLocation && (
          <DetailBlock icon={<MapPin size={13} />}>
            <span className="text-text-secondary">
              {[address.address, address.city, address.postcode].filter(Boolean).join(', ')}
            </span>
          </DetailBlock>
        )}

        {/* Counterparty (bank transfers) */}
        {counterparty && (
          <DetailBlock icon={<Users size={13} />}>
            <span className="text-text-secondary">
              {counterparty.preferred_name || counterparty.name}
            </span>
            {counterparty.sort_code && counterparty.account_number && (
              <span className="text-[10px] text-text-tertiary font-mono">
                {counterparty.sort_code.replace(/(..)(..)(..)/, '$1-$2-$3')} · {counterparty.account_number}
              </span>
            )}
          </DetailBlock>
        )}

        {/* Foreign currency */}
        {tx.local_currency && tx.local_currency !== tx.currency && (
          <DetailBlock icon={<PoundSterling size={13} />}>
            <span className="text-text-secondary">
              {(Math.abs(tx.local_amount ?? tx.amount) / 100).toFixed(2)} {tx.local_currency}
            </span>
          </DetailBlock>
        )}

        {/* Shared tab */}
        {tab && (
          <DetailBlock icon={<Users size={13} />}>
            <span className="text-text-secondary">{tab.name}</span>
            <span className="text-[10px] text-text-tertiary">
              {tab.participants.map((p) => p.first_name || p.name).join(' & ')}
              {' · '}{tab.item_count} items
            </span>
          </DetailBlock>
        )}

        {/* ATM fee info */}
        {atmFees?.allowance_usage_explainer_text && (
          <DetailBlock icon={<Info size={13} />}>
            <span className="text-[11px] text-text-tertiary">{atmFees.allowance_usage_explainer_text}</span>
          </DetailBlock>
        )}

        {/* Notes (editable) */}
        <DetailBlock icon={<MessageSquare size={13} />}>
          {editingNotes ? (
            <div className="flex gap-1 w-full">
              <input
                ref={notesRef}
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveNotes()
                  if (e.key === 'Escape') setEditingNotes(false)
                }}
                className="flex-1 px-2 py-0.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary"
              />
              <button
                onClick={saveNotes}
                className="px-2 py-0.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary hover:bg-surface-1"
              >
                Save
              </button>
            </div>
          ) : (
            <button onClick={startEditNotes} className="text-left text-text-secondary hover:text-text-primary transition-colors">
              {tx.notes || <span className="text-text-tertiary">Add a note...</span>}
            </button>
          )}
        </DetailBlock>

        {/* Merchant website */}
        {website && (
          <DetailBlock icon={<ExternalLink size={13} />}>
            <a
              href={website.startsWith('http') ? website : `https://${website}`}
              target="_blank"
              rel="noreferrer"
              className="text-text-tertiary hover:text-text-secondary transition-colors text-[11px]"
            >
              {website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
          </DetailBlock>
        )}
      </div>

      {/* Raw data */}
      <div className="mt-4 pt-3 border-t border-border">
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1"
        >
          <Info size={10} />
          {showRaw ? 'Hide raw data' : 'Raw data'}
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

/** Semantic content block — icon aligned left, stacked content right */
function DetailBlock({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 items-start">
      <span className="text-text-tertiary mt-0.5 flex-shrink-0 w-4">{icon}</span>
      <div className="flex-1 min-w-0 flex flex-col text-xs">{children}</div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function groupByDate(transactions: MonzoTransaction[]): [string, MonzoTransaction[]][] {
  const groups = new Map<string, MonzoTransaction[]>()
  for (const tx of transactions) {
    const date = tx.created.slice(0, 10) // YYYY-MM-DD
    const group = groups.get(date)
    if (group) {
      group.push(tx)
    } else {
      groups.set(date, [tx])
    }
  }
  return Array.from(groups.entries())
}

function formatDateGroup(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (dateStr === today.toISOString().slice(0, 10)) return 'Today'
  if (dateStr === yesterday.toISOString().slice(0, 10)) return 'Yesterday'

  return date.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}
