// Finance store — categories, rules, accounts, streams, budgets, scenarios,
// transaction overrides, settings; plus computed projection / runway /
// net-worth fetched from the hub.

import { create } from 'zustand'
import { hubFetch } from '@/hub'

// --- Types (mirror server/src/finance/types.ts) -----------------------------

export type Liquidity = 'liquid' | 'investment' | 'illiquid'
export type StreamKind = 'income' | 'expense'
export type Cadence = 'monthly' | 'yearly' | 'weekly'
export type CategoryKind = 'income' | 'expense' | 'transfer'

export interface Category {
  id: string
  name: string
  emoji: string
  color: string
  kind: CategoryKind
  variable?: boolean
  isSystem?: boolean
  archived?: boolean
}

export interface CategoryRule {
  id: string
  priority: number
  label?: string
  match: {
    merchantContains?: string
    descriptionContains?: string
    counterpartyContains?: string
    amountSign?: 'in' | 'out'
    monzoCategoryEquals?: string
  }
  categoryId: string
  ignore?: boolean
  asTransfer?: boolean
}

export interface BalanceEntry {
  id: string
  date: string
  balancePence: number
  note?: string
}

export interface Account {
  id: string
  name: string
  type: 'monzo' | 'manual'
  liquidity: Liquidity
  currency: string
  emoji?: string
  color?: string
  monzoAccountId?: string
  ledger?: BalanceEntry[]
  isExternal?: boolean
  sort?: number
  notes?: string
  archived?: boolean
  /** Annual % growth assumption used in projection (e.g. 6.5 for the MyMap 8 fund, 3.25 for a savings account). When unset, falls back to global `investmentGrowthPct` for investment accounts and 0% for liquid. */
  growthPctYoy?: number
}

export interface Stream {
  id: string
  name: string
  kind: StreamKind
  amountPence: number
  cadence: Cadence
  dayOfMonth?: number
  monthOfYear?: number
  startDate: string
  endDate?: string
  categoryId?: string
  accountId?: string
  growthPctYoy?: number
  notes?: string
  archived?: boolean
}

export interface Budget {
  id: string
  categoryId: string
  monthlyTargetPence: number
  rollover?: boolean
  notes?: string
}

export interface TxOverride {
  txId: string
  categoryId?: string
  ignore?: boolean
  pairedTxId?: string
}

export type Delta =
  | { kind: 'addStream'; tempId: string; stream: Omit<Stream, 'id'> & { id?: string } }
  | { kind: 'modifyStream'; streamId: string; patch: Partial<Stream> }
  | { kind: 'terminateStream'; streamId: string; date: string }
  | { kind: 'oneOff'; date: string; amountPence: number; categoryId?: string; accountId?: string; note?: string }
  | { kind: 'categoryAdjust'; categoryId: string; multiplier: number; from?: string; until?: string }
  | { kind: 'investmentGrowth'; annualPct: number }

export interface Scenario {
  id: string
  name: string
  description?: string
  deltas: Delta[]
  horizonMonths?: number
  createdAt: string
  updatedAt: string
}

export interface FinanceSettings {
  emergencyFund:
    | { mode: 'fixed'; valuePence: number }
    | { mode: 'months'; months: number }
  projectionHorizonMonths: number
  homeCurrency: string
  investmentGrowthPct: number
}

export interface MonthlyPoint {
  month: string
  inflowsPence: number
  outflowsPence: number
  oneOffsPence: number
  netPence: number
  liquidPence: number
  investmentPence: number
  totalPence: number
  belowEmergency: boolean
  inflowBreakdown: Array<{ label: string; amountPence: number }>
  outflowBreakdown: Array<{ label: string; amountPence: number; categoryId?: string }>
}

export interface RunwaySummary {
  liquidPence: number
  investmentPence: number
  totalPence: number
  emergencyFundPence: number
  monthlyBurnPence: number
  monthsToFloor: number
  floorDate: string | null
  monthsToZero: number
  zeroDate: string | null
}

export interface NetWorthSnapshot {
  date: string
  liquidPence: number
  investmentPence: number
  totalPence: number
  byAccount: Array<{ accountId: string; balancePence: number }>
}

export interface CategoryMonthlySpend {
  month: string
  byCategory: Record<string, number>
}

export interface BudgetStatus {
  budgetId: string
  categoryId: string
  monthlyTargetPence: number
  spentPence: number
  remainingPence: number
  pct: number
  projectedEndOfMonthPence: number
}

export interface RecurringCandidate {
  key: string
  label: string
  amountPence: number
  cadence: 'monthly'
  occurrences: number
  lastSeen: string
  sample: { txId: string }
  suggestedKind: 'income' | 'expense'
}

export interface TxClassification {
  categoryId: string
  ignored: boolean
  isTransfer: boolean
}

// --- Helpers ----------------------------------------------------------------

export function fmtPence(pence: number, opts: { showSign?: boolean; abs?: boolean } = {}): string {
  const v = opts.abs ? Math.abs(pence) : pence
  const sign = !opts.abs && opts.showSign && pence > 0 ? '+' : ''
  const num = Math.abs(v) / 100
  const fmt = num >= 1000
    ? num.toLocaleString('en-GB', { maximumFractionDigits: 0 })
    : num.toFixed(2)
  return `${sign}${v < 0 && !opts.abs ? '-' : ''}£${fmt}`
}

export function fmtMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(y!, m! - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

export function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number)
  const [yb, mb] = b.split('-').map(Number)
  return (yb! - ya!) * 12 + (mb! - ma!)
}

// --- Store ------------------------------------------------------------------

export type MoneySubTab = 'cashflow' | 'networth' | 'transactions' | 'budgets' | 'scenarios' | 'categories'

interface FinanceState {
  // Loading / lifecycle
  loading: boolean
  loaded: boolean

  // Tab
  activeSubTab: MoneySubTab
  setSubTab: (t: MoneySubTab) => void

  // Raw
  categories: Category[]
  rules: CategoryRule[]
  accounts: Account[]
  streams: Stream[]
  budgets: Budget[]
  scenarios: Scenario[]
  overrides: TxOverride[]
  settings: FinanceSettings | null

  // Computed (cached)
  classifications: Record<string, TxClassification>
  monthly: CategoryMonthlySpend[]
  variableForecast: Record<string, number>
  netWorth: NetWorthSnapshot | null
  netWorthHistory: NetWorthSnapshot[]
  trajectory: MonthlyPoint[]
  runway: RunwaySummary | null
  emergencyFundPence: number
  budgetStatus: BudgetStatus[]
  recurringCandidates: RecurringCandidate[]

  // Active scenario for projection viewing
  activeScenarioId: string | null
  setActiveScenario: (id: string | null) => void

  // Actions
  fetchAll: () => Promise<void>
  recompute: () => Promise<void>

  upsertCategory: (input: Partial<Category> & { name: string }) => Promise<Category>
  deleteCategory: (id: string) => Promise<void>

  upsertRule: (input: Partial<CategoryRule> & { categoryId: string; match: CategoryRule['match'] }) => Promise<CategoryRule>
  deleteRule: (id: string) => Promise<void>

  upsertAccount: (input: Partial<Account> & { name: string; type: Account['type']; liquidity: Account['liquidity'] }) => Promise<Account>
  deleteAccount: (id: string) => Promise<void>
  addBalanceEntry: (accountId: string, entry: { date: string; balancePence: number; note?: string }) => Promise<BalanceEntry>
  deleteBalanceEntry: (accountId: string, entryId: string) => Promise<void>

  upsertStream: (input: Partial<Stream> & { name: string; kind: Stream['kind']; amountPence: number; cadence: Stream['cadence']; startDate: string }) => Promise<Stream>
  deleteStream: (id: string) => Promise<void>

  upsertBudget: (input: Partial<Budget> & { categoryId: string; monthlyTargetPence: number }) => Promise<Budget>
  deleteBudget: (id: string) => Promise<void>

  upsertScenario: (input: Partial<Scenario> & { name: string }) => Promise<Scenario>
  deleteScenario: (id: string) => Promise<void>

  setOverride: (override: TxOverride) => Promise<void>
  clearOverride: (txId: string) => Promise<void>
  bulkSetOverrides: (items: TxOverride[]) => Promise<void>

  updateSettings: (patch: Partial<FinanceSettings>) => Promise<void>
}

const SUB_TAB_KEY = 'console:money:subtab'

function loadSubTab(): MoneySubTab {
  if (typeof localStorage === 'undefined') return 'cashflow'
  const v = localStorage.getItem(SUB_TAB_KEY) as MoneySubTab | null
  return v ?? 'cashflow'
}

export const useFinanceStore = create<FinanceState>((set, get) => ({
  loading: false,
  loaded: false,
  activeSubTab: loadSubTab(),
  setSubTab: (t) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SUB_TAB_KEY, t)
    set({ activeSubTab: t })
  },

  categories: [],
  rules: [],
  accounts: [],
  streams: [],
  budgets: [],
  scenarios: [],
  overrides: [],
  settings: null,

  classifications: {},
  monthly: [],
  variableForecast: {},
  netWorth: null,
  netWorthHistory: [],
  trajectory: [],
  runway: null,
  emergencyFundPence: 0,
  budgetStatus: [],
  recurringCandidates: [],

  activeScenarioId: null,
  setActiveScenario: (id) => {
    set({ activeScenarioId: id })
    void get().recompute()
  },

  fetchAll: async () => {
    set({ loading: true })
    try {
      const all = await hubFetch<{
        categories: Category[]
        rules: CategoryRule[]
        accounts: Account[]
        streams: Stream[]
        budgets: Budget[]
        scenarios: Scenario[]
        overrides: TxOverride[]
        settings: FinanceSettings
      }>('/finance/all')
      set({
        categories: all.categories,
        rules: all.rules,
        accounts: all.accounts,
        streams: all.streams,
        budgets: all.budgets,
        scenarios: all.scenarios,
        overrides: all.overrides,
        settings: all.settings,
        loaded: true,
      })
      await get().recompute()
    } finally {
      set({ loading: false })
    }
  },

  recompute: async () => {
    const { activeScenarioId, settings } = get()
    const horizon = settings?.projectionHorizonMonths ?? 24
    const scnQuery = activeScenarioId ? `&scenario=${activeScenarioId}` : ''
    try {
      const [classifications, monthly, variableForecast, netWorth, projection, budgetStatus, recurringCandidates] = await Promise.all([
        hubFetch<Record<string, TxClassification>>('/finance/categorise?limit=2000'),
        hubFetch<CategoryMonthlySpend[]>('/finance/monthly'),
        hubFetch<Record<string, number>>('/finance/variable-forecast?window=3'),
        hubFetch<NetWorthSnapshot>('/finance/networth'),
        hubFetch<{ trajectory: MonthlyPoint[]; runway: RunwaySummary; emergencyFundPence: number }>(`/finance/projection?horizon=${horizon}${scnQuery}`),
        hubFetch<BudgetStatus[]>('/finance/budget-status'),
        hubFetch<RecurringCandidate[]>('/finance/recurring/candidates'),
      ])
      set({
        classifications, monthly, variableForecast, netWorth,
        trajectory: projection.trajectory, runway: projection.runway,
        emergencyFundPence: projection.emergencyFundPence,
        budgetStatus, recurringCandidates,
      })
      // History is heavier; fetch separately and don't block first paint.
      hubFetch<NetWorthSnapshot[]>('/finance/networth/history?months=12').then((h) => set({ netWorthHistory: h })).catch(() => {})
    } catch (err) {
      console.error('[finance] recompute failed:', err)
    }
  },

  upsertCategory: async (input) => {
    const cat = input.id
      ? await hubFetch<Category>(`/finance/categories/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) })
      : await hubFetch<Category>('/finance/categories', { method: 'POST', body: JSON.stringify(input) })
    await get().fetchAll()
    return cat
  },

  deleteCategory: async (id) => {
    await hubFetch(`/finance/categories/${id}`, { method: 'DELETE' })
    await get().fetchAll()
  },

  upsertRule: async (input) => {
    const r = input.id
      ? await hubFetch<CategoryRule>(`/finance/rules/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) })
      : await hubFetch<CategoryRule>('/finance/rules', { method: 'POST', body: JSON.stringify(input) })
    await get().fetchAll()
    return r
  },

  deleteRule: async (id) => {
    await hubFetch(`/finance/rules/${id}`, { method: 'DELETE' })
    await get().fetchAll()
  },

  upsertAccount: async (input) => {
    const a = input.id
      ? await hubFetch<Account>(`/finance/accounts/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) })
      : await hubFetch<Account>('/finance/accounts', { method: 'POST', body: JSON.stringify(input) })
    await get().fetchAll()
    return a
  },

  deleteAccount: async (id) => {
    await hubFetch(`/finance/accounts/${id}`, { method: 'DELETE' })
    await get().fetchAll()
  },

  addBalanceEntry: async (accountId, entry) => {
    const e = await hubFetch<BalanceEntry>(`/finance/accounts/${accountId}/balance`, {
      method: 'POST',
      body: JSON.stringify(entry),
    })
    await get().fetchAll()
    return e
  },

  deleteBalanceEntry: async (accountId, entryId) => {
    await hubFetch(`/finance/accounts/${accountId}/balance/${entryId}`, { method: 'DELETE' })
    await get().fetchAll()
  },

  upsertStream: async (input) => {
    const s = input.id
      ? await hubFetch<Stream>(`/finance/streams/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) })
      : await hubFetch<Stream>('/finance/streams', { method: 'POST', body: JSON.stringify(input) })
    await get().fetchAll()
    return s
  },

  deleteStream: async (id) => {
    await hubFetch(`/finance/streams/${id}`, { method: 'DELETE' })
    await get().fetchAll()
  },

  upsertBudget: async (input) => {
    const b = await hubFetch<Budget>('/finance/budgets', { method: 'POST', body: JSON.stringify(input) })
    await get().fetchAll()
    return b
  },

  deleteBudget: async (id) => {
    await hubFetch(`/finance/budgets/${id}`, { method: 'DELETE' })
    await get().fetchAll()
  },

  upsertScenario: async (input) => {
    const s = input.id
      ? await hubFetch<Scenario>(`/finance/scenarios/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) })
      : await hubFetch<Scenario>('/finance/scenarios', { method: 'POST', body: JSON.stringify(input) })
    await get().fetchAll()
    return s
  },

  deleteScenario: async (id) => {
    await hubFetch(`/finance/scenarios/${id}`, { method: 'DELETE' })
    if (get().activeScenarioId === id) set({ activeScenarioId: null })
    await get().fetchAll()
  },

  setOverride: async (override) => {
    await hubFetch('/finance/overrides', { method: 'POST', body: JSON.stringify(override) })
    await get().recompute()
    set((s) => {
      const idx = s.overrides.findIndex((o) => o.txId === override.txId)
      const next = [...s.overrides]
      if (idx >= 0) next[idx] = { ...next[idx]!, ...override }
      else next.push(override)
      return { overrides: next }
    })
  },

  clearOverride: async (txId) => {
    await hubFetch(`/finance/overrides/${txId}`, { method: 'DELETE' })
    set((s) => ({ overrides: s.overrides.filter((o) => o.txId !== txId) }))
    await get().recompute()
  },

  bulkSetOverrides: async (items) => {
    await hubFetch('/finance/overrides', { method: 'POST', body: JSON.stringify(items) })
    await get().fetchAll()
  },

  updateSettings: async (patch) => {
    const settings = await hubFetch<FinanceSettings>('/finance/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    set({ settings })
    await get().recompute()
  },
}))
