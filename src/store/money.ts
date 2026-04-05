// Money store — Monzo banking integration

import { create } from 'zustand'

// --------------------------------------------------------------------------
// Types (mirror server-side MonzoClient types)
// --------------------------------------------------------------------------

export interface MonzoAccount {
  id: string
  description: string
  created: string
}

export interface MonzoBalance {
  balance: number
  total_balance: number
  currency: string
  spend_today: number
}

export interface MonzoMerchant {
  id: string
  group_id: string
  name: string
  logo: string
  emoji: string
  category: string
  online?: boolean
  address?: {
    address: string
    city: string
    country: string
    latitude: number
    longitude: number
    postcode: string
    region: string
  }
}

export interface MonzoCounterparty {
  account_id?: string
  name?: string
  preferred_name?: string
  user_id?: string
  sort_code?: string
  account_number?: string
}

export interface MonzoTabParticipant {
  name: string
  first_name?: string
  settle_amount: number
  settle_currency: string
  status: string
}

export interface MonzoTab {
  id: string
  name: string
  participants: MonzoTabParticipant[]
  item_count: number
  total: number
  currency: string
  status: string
}

export interface MonzoAtmFees {
  fee_amount: number
  fee_currency: string
  withdrawal_amount: number
  allowance_usage_explainer_text?: string
}

export interface MonzoTransaction {
  id: string
  amount: number
  currency: string
  created: string
  settled: string
  description: string
  merchant: MonzoMerchant | string | null
  counterparty?: MonzoCounterparty
  notes: string
  metadata: Record<string, string>
  category: string
  is_load: boolean
  decline_reason?: string
  account_id: string
  scheme?: string
  local_amount?: number
  local_currency?: string
  tab?: MonzoTab
  atm_fees_detailed?: MonzoAtmFees | null
}

export interface MonzoPot {
  id: string
  name: string
  style: string
  balance: number
  currency: string
  created: string
  updated: string
  deleted: boolean
}

export interface MoneyStatus {
  connected: boolean
  hasCredentials: boolean
  accountId: string | null
  lastSync: string | null
  transactionCount: number
  fullSyncComplete: boolean
}

// --------------------------------------------------------------------------
// Hub URL
// --------------------------------------------------------------------------

function getHubUrl(): string {
  return localStorage.getItem('console_hub_url') || 'http://localhost:9877'
}

async function hubFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${getHubUrl()}${path}`, opts)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// --------------------------------------------------------------------------
// Category definitions
// --------------------------------------------------------------------------

export const MONZO_CATEGORIES: Record<string, { label: string; icon: string }> = {
  general: { label: 'General', icon: 'Circle' },
  eating_out: { label: 'Eating Out', icon: 'UtensilsCrossed' },
  expenses: { label: 'Expenses', icon: 'Receipt' },
  transport: { label: 'Transport', icon: 'Train' },
  cash: { label: 'Cash', icon: 'Banknote' },
  bills: { label: 'Bills', icon: 'FileText' },
  entertainment: { label: 'Entertainment', icon: 'Film' },
  shopping: { label: 'Shopping', icon: 'ShoppingBag' },
  holidays: { label: 'Holidays', icon: 'Plane' },
  groceries: { label: 'Groceries', icon: 'Apple' },
}

// --------------------------------------------------------------------------
// Format helpers
// --------------------------------------------------------------------------

/** Format minor units (pennies) to pounds string */
export function formatAmount(amount: number, _currency = 'GBP'): string {
  const abs = Math.abs(amount) / 100
  const sign = amount < 0 ? '-' : amount > 0 ? '+' : ''
  return `${sign}£${abs.toFixed(2)}`
}

/** Format just the number (no sign) */
export function formatAmountAbs(amount: number): string {
  return `£${(Math.abs(amount) / 100).toFixed(2)}`
}

/** Get display name — prefers counterparty for bank transfers, merchant for card */
export function getDisplayName(tx: MonzoTransaction): string {
  if (typeof tx.merchant === 'object' && tx.merchant) return tx.merchant.name
  if (tx.counterparty?.name) return tx.counterparty.name
  return tx.description
}

/** Get reference/subtitle — description for transfers, raw description for card */
export function getReference(tx: MonzoTransaction): string {
  if (tx.counterparty?.name) return tx.description // For transfers, description is the reference
  return ''
}

/** Get merchant name from transaction */
export function getMerchantName(tx: MonzoTransaction): string {
  if (typeof tx.merchant === 'object' && tx.merchant) return tx.merchant.name
  return tx.description
}

/** Get merchant emoji from transaction */
export function getMerchantEmoji(tx: MonzoTransaction): string {
  if (typeof tx.merchant === 'object' && tx.merchant) return tx.merchant.emoji || ''
  return ''
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

interface MoneyState {
  // Connection
  status: MoneyStatus | null
  loading: boolean
  syncing: boolean

  // Data
  accounts: MonzoAccount[]
  balance: MonzoBalance | null
  transactions: MonzoTransaction[]
  pots: MonzoPot[]
  spendingByCategory: Record<string, number>

  // Selection
  selectedTransactionId: string | null

  // Filters
  searchQuery: string
  categoryFilter: string | null

  // Actions
  fetchStatus: () => Promise<void>
  fetchAll: () => Promise<void>
  fetchBalance: () => Promise<void>
  fetchTransactions: (opts?: { limit?: number; offset?: number }) => Promise<void>
  fetchPots: () => Promise<void>
  fetchSpending: (month?: string) => Promise<void>
  refreshSync: () => Promise<void>
  selectTransaction: (id: string | null) => void
  selectNextTransaction: () => void
  selectPrevTransaction: () => void
  setSearchQuery: (q: string) => void
  setCategoryFilter: (cat: string | null) => void
  annotateTransaction: (id: string, key: string, value: string) => Promise<void>
  depositToPot: (potId: string, amount: number) => Promise<void>
  withdrawFromPot: (potId: string, amount: number) => Promise<void>
  handleWebhookTransaction: (tx: MonzoTransaction) => void
}

export const useMoneyStore = create<MoneyState>((set, get) => ({
  status: null,
  loading: false,
  syncing: false,
  accounts: [],
  balance: null,
  transactions: [],
  pots: [],
  spendingByCategory: {},
  selectedTransactionId: null,
  searchQuery: '',
  categoryFilter: null,

  fetchStatus: async () => {
    try {
      const status = await hubFetch<MoneyStatus>('/money/status')
      set({ status })
    } catch {
      set({ status: { connected: false, hasCredentials: false, accountId: null, lastSync: null, transactionCount: 0, fullSyncComplete: false } })
    }
  },

  fetchAll: async () => {
    set({ loading: true })
    try {
      const [balance, pots] = await Promise.all([
        hubFetch<MonzoBalance>('/money/balance'),
        hubFetch<MonzoPot[]>('/money/pots'),
      ])
      set({ balance, pots })

      // Fetch transactions
      const transactions = await hubFetch<MonzoTransaction[]>('/money/transactions?limit=500')
      set({ transactions })

      // Fetch spending
      const spendingByCategory = await hubFetch<Record<string, number>>('/money/spending')
      set({ spendingByCategory })
    } catch (err) {
      console.error('[money] fetchAll failed:', err)
    } finally {
      set({ loading: false })
    }
  },

  fetchBalance: async () => {
    try {
      const balance = await hubFetch<MonzoBalance>('/money/balance')
      set({ balance })
    } catch (err) {
      console.error('[money] fetchBalance failed:', err)
    }
  },

  fetchTransactions: async (opts) => {
    try {
      const { searchQuery, categoryFilter } = get()
      const params = new URLSearchParams()
      if (opts?.limit) params.set('limit', opts.limit.toString())
      if (opts?.offset) params.set('offset', opts.offset.toString())
      if (categoryFilter) params.set('category', categoryFilter)
      if (searchQuery) params.set('search', searchQuery)
      const qs = params.toString()
      const transactions = await hubFetch<MonzoTransaction[]>(`/money/transactions${qs ? `?${qs}` : '?limit=500'}`)
      set({ transactions })
    } catch (err) {
      console.error('[money] fetchTransactions failed:', err)
    }
  },

  fetchPots: async () => {
    try {
      const pots = await hubFetch<MonzoPot[]>('/money/pots')
      set({ pots })
    } catch (err) {
      console.error('[money] fetchPots failed:', err)
    }
  },

  fetchSpending: async (month) => {
    try {
      const params = month ? `?month=${month}` : ''
      const spendingByCategory = await hubFetch<Record<string, number>>(`/money/spending${params}`)
      set({ spendingByCategory })
    } catch (err) {
      console.error('[money] fetchSpending failed:', err)
    }
  },

  refreshSync: async () => {
    set({ syncing: true })
    try {
      await hubFetch('/money/sync', { method: 'POST' })
      // Re-fetch everything after sync
      await get().fetchAll()
      await get().fetchStatus()
    } catch (err) {
      console.error('[money] sync failed:', err)
    } finally {
      set({ syncing: false })
    }
  },

  selectTransaction: (id) => set({ selectedTransactionId: id }),

  selectNextTransaction: () => {
    const { transactions, selectedTransactionId } = get()
    if (transactions.length === 0) return
    if (!selectedTransactionId) {
      set({ selectedTransactionId: transactions[0]?.id ?? null })
      return
    }
    const idx = transactions.findIndex((t) => t.id === selectedTransactionId)
    if (idx < transactions.length - 1) {
      set({ selectedTransactionId: transactions[idx + 1]!.id })
    }
  },

  selectPrevTransaction: () => {
    const { transactions, selectedTransactionId } = get()
    if (transactions.length === 0) return
    if (!selectedTransactionId) {
      set({ selectedTransactionId: transactions[0]?.id ?? null })
      return
    }
    const idx = transactions.findIndex((t) => t.id === selectedTransactionId)
    if (idx > 0) {
      set({ selectedTransactionId: transactions[idx - 1]!.id })
    }
  },

  setSearchQuery: (q) => {
    set({ searchQuery: q })
    get().fetchTransactions()
  },

  setCategoryFilter: (cat) => {
    set({ categoryFilter: cat })
    get().fetchTransactions()
  },

  annotateTransaction: async (id, key, value) => {
    try {
      const updated = await hubFetch<MonzoTransaction>(`/money/transactions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { [key]: value } }),
      })
      set((s) => ({
        transactions: s.transactions.map((t) => (t.id === id ? updated : t)),
      }))
    } catch (err) {
      console.error('[money] annotate failed:', err)
    }
  },

  depositToPot: async (potId, amount) => {
    try {
      await hubFetch(`/money/pots/${potId}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      })
      // Refresh balance and pots
      await Promise.all([get().fetchBalance(), get().fetchPots()])
    } catch (err) {
      console.error('[money] deposit failed:', err)
    }
  },

  withdrawFromPot: async (potId, amount) => {
    try {
      await hubFetch(`/money/pots/${potId}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      })
      await Promise.all([get().fetchBalance(), get().fetchPots()])
    } catch (err) {
      console.error('[money] withdraw failed:', err)
    }
  },

  handleWebhookTransaction: (tx) => {
    set((s) => {
      const existing = s.transactions.findIndex((t) => t.id === tx.id)
      if (existing >= 0) {
        const txns = [...s.transactions]
        txns[existing] = tx
        return { transactions: txns }
      }
      return { transactions: [tx, ...s.transactions] }
    })
  },
}))
