// Finance subsystem — shared type definitions.
//
// All monetary values are integer pence (positive numbers). Sign comes from
// the kind: streams have kind 'income' | 'expense'; deltas use signed amounts
// where positive = inflow.

export type Liquidity = 'liquid' | 'investment' | 'illiquid'
export type StreamKind = 'income' | 'expense'
export type Cadence = 'monthly' | 'yearly' | 'weekly'
export type CategoryKind = 'income' | 'expense' | 'transfer'

export interface Category {
  id: string
  name: string
  emoji: string
  color: string // hex like '#a78bfa'
  kind: CategoryKind
  /** Variable spend by default; if false, it's expected to come entirely from streams (rent, salary, etc.) */
  variable?: boolean
  isSystem?: boolean
  archived?: boolean
}

export interface CategoryRule {
  id: string
  /** Lower number = higher priority. */
  priority: number
  /** Human-readable label for the rule. */
  label?: string
  /** Match conditions — all conditions present must match (AND). */
  match: {
    merchantContains?: string
    descriptionContains?: string
    counterpartyContains?: string
    /** 'in' = positive amount only, 'out' = negative only. */
    amountSign?: 'in' | 'out'
    monzoCategoryEquals?: string
  }
  categoryId: string
  /** If set, also marks the transaction with this flag. */
  ignore?: boolean
  asTransfer?: boolean
}

export interface BalanceEntry {
  id: string
  date: string // YYYY-MM-DD
  balancePence: number
  note?: string
}

export interface Account {
  id: string
  name: string
  /** monzo accounts are linked to the existing Monzo store; manual ones use the ledger. */
  type: 'monzo' | 'manual'
  liquidity: Liquidity
  currency: string // 'GBP'
  emoji?: string
  color?: string
  /** Linked Monzo account id when type === 'monzo'. */
  monzoAccountId?: string
  /** Manual balance entries — newest last. */
  ledger?: BalanceEntry[]
  /** Held by someone else on your behalf — included in net worth but not directly drawable. */
  isExternal?: boolean
  /** Display order, lower first. */
  sort?: number
  notes?: string
  archived?: boolean
}

export interface Stream {
  id: string
  name: string
  kind: StreamKind
  amountPence: number // positive
  cadence: Cadence
  /** For monthly: 1-31. For weekly: 0=Sun..6=Sat. */
  dayOfMonth?: number
  /** For yearly cadence: 1-12. */
  monthOfYear?: number
  startDate: string // YYYY-MM-DD
  endDate?: string // YYYY-MM-DD inclusive
  categoryId?: string
  accountId?: string
  /** Compounding annual growth applied each year past startDate. */
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
  /** Monzo transaction id. */
  txId: string
  categoryId?: string
  ignore?: boolean
  /** Paired-transaction id for transfer detection. */
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
  /** Optional override for projection horizon. */
  horizonMonths?: number
  createdAt: string
  updatedAt: string
}

export interface FinanceSettings {
  emergencyFund:
    | { mode: 'fixed'; valuePence: number }
    | { mode: 'months'; months: number }
  projectionHorizonMonths: number // default 24
  /** ISO currency code, default 'GBP'. */
  homeCurrency: string
  /** Annual % growth applied to investment-class accounts in projections. */
  investmentGrowthPct: number
}

export interface FinanceData {
  categories: Category[]
  rules: CategoryRule[]
  accounts: Account[]
  streams: Stream[]
  budgets: Budget[]
  scenarios: Scenario[]
  overrides: TxOverride[]
  settings: FinanceSettings
}

// --- Computed shapes (returned by routes / projection engine) ----------------

export interface MonthlyPoint {
  /** YYYY-MM */
  month: string
  inflowsPence: number
  outflowsPence: number
  oneOffsPence: number // signed
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
  monthlyBurnPence: number // signed: typically negative
  /** Months until balance hits the emergency floor. Infinity if positive cashflow. */
  monthsToFloor: number
  floorDate: string | null
  /** Months until balance hits zero, ignoring the emergency floor. */
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
