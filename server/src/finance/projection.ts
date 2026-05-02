// Pure functions for finance computation: rule-based categorisation, monthly
// aggregation, recurring-stream materialisation, projection engine, runway.
//
// All amounts are integer pence. Time granularity is one month: each month is
// represented as 'YYYY-MM' and the engine emits one MonthlyPoint per month.
// All inputs are plain data (no I/O), so the same logic works in tests and
// could be ported client-side if scenario tweaking ever needs sub-100ms feel.

import type {
  Account, Budget, Category, CategoryRule, Delta, FinanceSettings, Liquidity,
  MonthlyPoint, NetWorthSnapshot, RunwaySummary, Scenario, Stream, TxOverride,
} from './types.js'
import type { MonzoTransaction } from '../monzo-client.js'

// --------------------------------------------------------------------------
// Categorisation
// --------------------------------------------------------------------------

/**
 * Resolve a transaction's effective category by checking overrides, then
 * matching rules in priority order, then falling back to Monzo's category
 * via the default Monzo→user-category mapping (handled by rules), then to
 * 'cat_uncat'.
 *
 * Returns the effective shared fraction (0..1) for the transaction. The
 * variable-spend forecast multiplies tx.amount by this fraction so the
 * projection reflects the user's *net* cost on shared expenses. Defaults
 * to 1.0 (fully the user's).
 */
export function effectiveCategory(
  tx: MonzoTransaction,
  rules: CategoryRule[],
  overrides: TxOverride[],
): { categoryId: string; ignored: boolean; isTransfer: boolean; sharedFraction: number; sharedWithCounterparty?: string } {
  const override = overrides.find((o) => o.txId === tx.id)
  // Override fully drops out the rest, but its sharedFraction defaults to 1
  // unless it explicitly sets one, in which case it always wins.
  if (override?.ignore) return {
    categoryId: override.categoryId ?? 'cat_uncat', ignored: true, isTransfer: false,
    sharedFraction: 1, sharedWithCounterparty: override.sharedWithCounterparty,
  }

  const merchantName = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant.name : ''
  const counterparty = (tx as unknown as { counterparty?: { name?: string } }).counterparty?.name ?? ''
  const description = tx.description ?? ''
  const amountSign: 'in' | 'out' = tx.amount >= 0 ? 'in' : 'out'

  // Walk rules first to find a baseline classification (so sharedFraction
  // from a matching rule still applies even when an override only changes
  // the category).
  let baseRule: CategoryRule | undefined
  for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
    const m = rule.match
    if (m.amountSign && m.amountSign !== amountSign) continue
    // merchantContains is friendly: matches against either the merchant name
    // (card payments) or the counterparty name (faster payments / direct
    // debits / Monzo-to-Monzo). Avoids needing a duplicate rule per tx type.
    if (m.merchantContains) {
      const needle = m.merchantContains.toLowerCase()
      const m1 = merchantName.toLowerCase().includes(needle)
      const m2 = counterparty.toLowerCase().includes(needle)
      if (!m1 && !m2) continue
    }
    if (m.descriptionContains && !description.toLowerCase().includes(m.descriptionContains.toLowerCase())) continue
    if (m.counterpartyContains && !counterparty.toLowerCase().includes(m.counterpartyContains.toLowerCase())) continue
    if (m.monzoCategoryEquals && tx.category !== m.monzoCategoryEquals) continue
    baseRule = rule; break
  }

  if (override?.categoryId) {
    return {
      categoryId: override.categoryId,
      ignored: false,
      isTransfer: override.categoryId === 'cat_transfer',
      sharedFraction: override.sharedFraction ?? baseRule?.sharedFraction ?? 1,
      sharedWithCounterparty: override.sharedWithCounterparty ?? baseRule?.sharedWithCounterparty,
    }
  }
  if (baseRule) {
    return {
      categoryId: baseRule.categoryId,
      ignored: !!baseRule.ignore,
      isTransfer: !!baseRule.asTransfer || baseRule.categoryId === 'cat_transfer',
      sharedFraction: baseRule.sharedFraction ?? 1,
      sharedWithCounterparty: baseRule.sharedWithCounterparty,
    }
  }
  return { categoryId: 'cat_uncat', ignored: false, isTransfer: false, sharedFraction: 1 }
}

// --------------------------------------------------------------------------
// Transfer detection
// --------------------------------------------------------------------------

/**
 * Find candidate transfer pairs in Monzo transactions: opposite-sign amounts
 * within ±2 days that haven't already been overridden. Returns suggestions
 * the user can confirm — does not mutate the store.
 */
export function findTransferCandidates(
  txns: MonzoTransaction[],
  overrides: TxOverride[],
): Array<{ outId: string; inId: string; amountPence: number }> {
  const seen = new Set(overrides.filter((o) => o.pairedTxId).flatMap((o) => [o.txId, o.pairedTxId!]))
  const candidates: Array<{ outId: string; inId: string; amountPence: number }> = []
  const sorted = [...txns].filter((t) => !seen.has(t.id) && !t.decline_reason).sort(
    (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime(),
  )
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    if (a.amount >= 0) continue
    const aTime = new Date(a.created).getTime()
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!
      const dt = new Date(b.created).getTime() - aTime
      if (dt > 3 * 24 * 3600 * 1000) break
      if (b.amount === -a.amount) {
        candidates.push({ outId: a.id, inId: b.id, amountPence: -a.amount })
        break
      }
    }
  }
  return candidates
}

// --------------------------------------------------------------------------
// Monthly aggregation of historical Monzo data
// --------------------------------------------------------------------------

export interface CategoryMonthlySpend {
  /** YYYY-MM */
  month: string
  /** categoryId → pence (positive for spend, negative for income) */
  byCategory: Record<string, number>
}

export function aggregateMonthlySpend(
  txns: MonzoTransaction[],
  rules: CategoryRule[],
  overrides: TxOverride[],
): CategoryMonthlySpend[] {
  const map = new Map<string, Record<string, number>>()
  for (const tx of txns) {
    if (tx.decline_reason) continue
    const eff = effectiveCategory(tx, rules, overrides)
    if (eff.ignored || eff.isTransfer) continue
    const month = tx.created.slice(0, 7)
    if (!map.has(month)) map.set(month, {})
    const m = map.get(month)!
    // Convention: store as positive pence for outflows, negative for inflows.
    // Apply sharedFraction so shared categories (e.g. groceries split with a
    // partner) contribute only the user's share to the projection forecast.
    const amt = Math.round(-tx.amount * eff.sharedFraction)
    m[eff.categoryId] = (m[eff.categoryId] ?? 0) + amt
  }
  return Array.from(map.entries())
    .map(([month, byCategory]) => ({ month, byCategory }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

/**
 * Trailing N-month average outflow per category. Used as the variable-spend
 * forecast input. Excludes income (negative values) — those are handled by
 * streams.
 */
export function trailingCategoryAverage(
  monthly: CategoryMonthlySpend[],
  windowMonths: number,
): Record<string, number> {
  if (monthly.length === 0) return {}
  const window = monthly.slice(-windowMonths)
  if (window.length === 0) return {}
  const sums: Record<string, number> = {}
  for (const m of window) {
    for (const [catId, pence] of Object.entries(m.byCategory)) {
      if (pence <= 0) continue
      sums[catId] = (sums[catId] ?? 0) + pence
    }
  }
  const out: Record<string, number> = {}
  for (const [catId, total] of Object.entries(sums)) {
    out[catId] = Math.round(total / window.length)
  }
  return out
}

// --------------------------------------------------------------------------
// Stream materialisation
// --------------------------------------------------------------------------

/**
 * For a given month (YYYY-MM), compute the signed net pence each active stream
 * contributes. Positive = inflow (income), negative = outflow (expense).
 */
export function streamAmountForMonth(stream: Stream, month: string): number {
  if (stream.archived) return 0
  const [yearStr, monthStr] = month.split('-')
  const year = parseInt(yearStr!, 10)
  const m = parseInt(monthStr!, 10)
  const monthStart = new Date(Date.UTC(year, m - 1, 1))
  const monthEnd = new Date(Date.UTC(year, m, 0))
  const start = new Date(stream.startDate + 'T00:00:00Z')
  if (start > monthEnd) return 0
  if (stream.endDate) {
    const end = new Date(stream.endDate + 'T23:59:59Z')
    if (end < monthStart) return 0
  }

  const sign = stream.kind === 'income' ? 1 : -1
  const yearsSinceStart = year - start.getUTCFullYear() + (m - 1 - start.getUTCMonth()) / 12
  const growth = stream.growthPctYoy ? Math.pow(1 + stream.growthPctYoy / 100, yearsSinceStart) : 1
  const amount = stream.amountPence * growth

  switch (stream.cadence) {
    case 'monthly':
      return Math.round(sign * amount)
    case 'yearly':
      if (stream.monthOfYear && m === stream.monthOfYear) return Math.round(sign * amount)
      // No monthOfYear set — spread evenly across the year
      if (!stream.monthOfYear) return Math.round(sign * amount / 12)
      return 0
    case 'weekly':
      // ~4.345 weeks per month
      return Math.round(sign * amount * 4.345)
  }
}

// --------------------------------------------------------------------------
// Net worth from accounts + Monzo balance + manual ledger
// --------------------------------------------------------------------------

export interface BalanceLookup {
  /** Returns balance in pence on a given YYYY-MM-DD (uses latest ≤ date). */
  on(date: string): number
}

/**
 * Build a balance lookup for an account.
 * - Monzo: uses the live balance for "today" and falls back to historical
 *   reconstruction from transaction deltas when looking back. The Monzo
 *   adapter is supplied externally because the store has the authoritative
 *   transaction list.
 * - Manual: linear interpolation between adjacent ledger entries; latest
 *   entry persists forward.
 */
export function manualBalanceLookup(account: Account): BalanceLookup {
  const ledger = (account.ledger ?? []).slice().sort((a, b) => a.date.localeCompare(b.date))
  return {
    on(date: string): number {
      if (ledger.length === 0) return 0
      // Find the latest entry on or before the requested date
      let result = 0
      let found = false
      for (const e of ledger) {
        if (e.date <= date) { result = e.balancePence; found = true } else break
      }
      // Before the first entry — use the earliest known balance (best we can do).
      if (!found) return ledger[0]!.balancePence
      return result
    },
  }
}

export interface NetWorthInput {
  accounts: Account[]
  /** Returns current/at-date balance for an account. */
  balanceFor: (accountId: string, date: string) => number
}

export function computeNetWorthOn(date: string, input: NetWorthInput): NetWorthSnapshot {
  let liquid = 0
  let investment = 0
  const byAccount: Array<{ accountId: string; balancePence: number }> = []
  for (const acc of input.accounts) {
    if (acc.archived) continue
    const bal = input.balanceFor(acc.id, date)
    byAccount.push({ accountId: acc.id, balancePence: bal })
    if (acc.liquidity === 'liquid') liquid += bal
    else if (acc.liquidity === 'investment') investment += bal
    // 'illiquid' — counted in total but separated visually elsewhere
  }
  return { date, liquidPence: liquid, investmentPence: investment, totalPence: liquid + investment, byAccount }
}

/**
 * History snapshot per month. For each month-end date, runs computeNetWorthOn.
 */
export function netWorthHistory(months: string[], input: NetWorthInput): NetWorthSnapshot[] {
  return months.map((m) => {
    const [y, mm] = m.split('-').map(Number)
    const lastDay = new Date(Date.UTC(y!, mm!, 0))
    const date = lastDay.toISOString().slice(0, 10)
    return computeNetWorthOn(date, input)
  })
}

// --------------------------------------------------------------------------
// Burn rate
// --------------------------------------------------------------------------

/**
 * Trailing N-month net cashflow average from Monzo data — signed pence.
 * Negative = burning money. Excludes ignored and transfer transactions.
 */
export function trailingBurn(
  txns: MonzoTransaction[],
  rules: CategoryRule[],
  overrides: TxOverride[],
  windowMonths: number,
): number {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - windowMonths)
  cutoff.setDate(1)
  const cutoffISO = cutoff.toISOString().slice(0, 10)

  let total = 0
  let monthsSeen = new Set<string>()
  for (const tx of txns) {
    if (tx.decline_reason) continue
    if (tx.created.slice(0, 10) < cutoffISO) continue
    const eff = effectiveCategory(tx, rules, overrides)
    if (eff.ignored || eff.isTransfer) continue
    total += tx.amount // signed: negative for spend
    monthsSeen.add(tx.created.slice(0, 7))
  }
  const months = Math.max(1, monthsSeen.size)
  return Math.round(total / months)
}

// --------------------------------------------------------------------------
// Projection
// --------------------------------------------------------------------------

export interface ProjectInput {
  /** YYYY-MM of the first projected month (typically current month). */
  startMonth: string
  horizonMonths: number
  /**
   * Optional pre-flattened opening balances. If `accounts` is provided, that
   * takes precedence and per-account growth is tracked individually. These
   * are kept so legacy callers / tests still work.
   */
  openingLiquidPence?: number
  openingInvestmentPence?: number
  /**
   * Per-account opening balances + growth. When provided, the engine tracks
   * each account separately so a 3.25% savings account and a 6.5% equity
   * fund grow at their own rates. Liquid accounts grow too (interest), but
   * spending/income flows always hit a single notional liquid pool.
   */
  accounts?: Array<{
    id: string
    name: string
    liquidity: Liquidity
    balancePence: number
    growthPctYoy?: number
  }>
  streams: Stream[]
  /** categoryId → expected monthly outflow pence (positive). */
  variableForecast: Record<string, number>
  categories: Category[]
  emergencyFundPence: number
  /** Annual % growth fallback for investment accounts without per-account override. 0 disables. */
  investmentGrowthPct: number
  /** Optional scenario to overlay. */
  scenario?: Scenario | null
}

export function project(input: ProjectInput): MonthlyPoint[] {
  const months = enumerateMonths(input.startMonth, input.horizonMonths)
  const deltas = input.scenario?.deltas ?? []
  const growthOverride = deltas.find((d) => d.kind === 'investmentGrowth') as { kind: 'investmentGrowth'; annualPct: number } | undefined
  const fallbackGrowthPct = growthOverride?.annualPct ?? input.investmentGrowthPct

  // Per-account state. Liquid accounts get summed into a single pool that
  // absorbs cashflow; each gets its own monthly interest. Investment
  // accounts grow individually. If `accounts` isn't supplied, fall back to
  // the legacy single-pool model using openingLiquidPence/openingInvestmentPence.
  interface AcctState { id: string; name: string; liquidity: Liquidity; balance: number; monthlyGrowth: number }
  const acctStates: AcctState[] = (input.accounts ?? []).map((a) => ({
    id: a.id, name: a.name, liquidity: a.liquidity,
    balance: a.balancePence,
    monthlyGrowth: Math.pow(1 + (a.growthPctYoy ?? (a.liquidity === 'investment' ? fallbackGrowthPct : 0)) / 100, 1 / 12) - 1,
  }))
  const usingPerAccount = acctStates.length > 0
  // Legacy fallback state
  let legacyLiquid = input.openingLiquidPence ?? 0
  let legacyInvestment = input.openingInvestmentPence ?? 0
  const legacyMonthlyGrowth = Math.pow(1 + fallbackGrowthPct / 100, 1 / 12) - 1
  // Pick the largest liquid account as the cashflow sink (income/expenses).
  // If none, fall back to legacy.
  const sinkAccount = acctStates.filter((a) => a.liquidity === 'liquid').sort((a, b) => b.balance - a.balance)[0]

  // Pre-compute scenario derivations
  const addedStreams: Stream[] = []
  const modifiedStreamPatches = new Map<string, Partial<Stream>>()
  const terminationDates = new Map<string, string>()
  const oneOffs: Array<{ date: string; amountPence: number; categoryId?: string; note?: string }> = []
  const categoryAdjusts: Array<{ categoryId: string; multiplier: number; from?: string; until?: string }> = []
  for (const d of deltas) {
    if (d.kind === 'addStream') {
      addedStreams.push({ id: d.tempId, ...d.stream } as Stream)
    } else if (d.kind === 'modifyStream') {
      modifiedStreamPatches.set(d.streamId, d.patch)
    } else if (d.kind === 'terminateStream') {
      terminationDates.set(d.streamId, d.date)
    } else if (d.kind === 'oneOff') {
      oneOffs.push({ date: d.date, amountPence: d.amountPence, categoryId: d.categoryId, note: d.note })
    } else if (d.kind === 'categoryAdjust') {
      categoryAdjusts.push({ categoryId: d.categoryId, multiplier: d.multiplier, from: d.from, until: d.until })
    }
  }

  const allStreams = [
    ...input.streams.map((s) => {
      const patch = modifiedStreamPatches.get(s.id) ?? {}
      const term = terminationDates.get(s.id)
      return {
        ...s,
        ...patch,
        endDate: term ?? patch.endDate ?? s.endDate,
      } as Stream
    }),
    ...addedStreams,
  ]

  const pts: MonthlyPoint[] = []

  for (const month of months) {
    let inflows = 0
    let outflows = 0
    let oneOffsNet = 0
    const inflowBreakdown: Array<{ label: string; amountPence: number }> = []
    const outflowBreakdown: Array<{ label: string; amountPence: number; categoryId?: string }> = []

    for (const stream of allStreams) {
      const v = streamAmountForMonth(stream, month)
      if (v > 0) {
        inflows += v
        inflowBreakdown.push({ label: stream.name, amountPence: v })
      } else if (v < 0) {
        outflows += -v
        outflowBreakdown.push({ label: stream.name, amountPence: -v, categoryId: stream.categoryId })
      }
    }

    // Variable spend per category — skip categories already covered by an
    // active fixed (non-variable) stream this month, otherwise we'd
    // double-count rent.
    const coveredCategories = new Set<string>()
    for (const s of allStreams) {
      if (s.kind !== 'expense' || !s.categoryId) continue
      if (streamAmountForMonth(s, month) === 0) continue
      const cat = input.categories.find((c) => c.id === s.categoryId)
      if (cat && cat.variable === false) coveredCategories.add(s.categoryId)
    }
    for (const [catId, basePence] of Object.entries(input.variableForecast)) {
      if (coveredCategories.has(catId)) continue
      let amt = basePence
      for (const adj of categoryAdjusts) {
        if (adj.categoryId !== catId) continue
        if (adj.from && month < adj.from) continue
        if (adj.until && month > adj.until) continue
        amt = Math.round(amt * adj.multiplier)
      }
      if (amt > 0) {
        outflows += amt
        const cat = input.categories.find((c) => c.id === catId)
        outflowBreakdown.push({ label: cat?.name ?? catId, amountPence: amt, categoryId: catId })
      }
    }

    // One-offs
    for (const o of oneOffs) {
      if (o.date.slice(0, 7) !== month) continue
      oneOffsNet += o.amountPence
      if (o.amountPence >= 0) {
        inflowBreakdown.push({ label: o.note ?? 'One-off', amountPence: o.amountPence })
      } else {
        outflowBreakdown.push({ label: o.note ?? 'One-off', amountPence: -o.amountPence, categoryId: o.categoryId })
      }
    }

    const net = inflows - outflows + oneOffsNet

    let liquidTotal: number
    let investmentTotal: number
    if (usingPerAccount) {
      // Cashflow lands in the largest liquid account
      if (sinkAccount) sinkAccount.balance += net
      // Apply per-account monthly growth
      for (const a of acctStates) a.balance = Math.round(a.balance * (1 + a.monthlyGrowth))
      liquidTotal = acctStates.filter((a) => a.liquidity === 'liquid').reduce((s, a) => s + a.balance, 0)
      investmentTotal = acctStates.filter((a) => a.liquidity === 'investment').reduce((s, a) => s + a.balance, 0)
      // Keep an "illiquid" leg out — already 0 in practice
    } else {
      legacyLiquid += net
      legacyInvestment = Math.round(legacyInvestment * (1 + legacyMonthlyGrowth))
      liquidTotal = legacyLiquid
      investmentTotal = legacyInvestment
    }

    pts.push({
      month,
      inflowsPence: inflows,
      outflowsPence: outflows,
      oneOffsPence: oneOffsNet,
      netPence: net,
      liquidPence: liquidTotal,
      investmentPence: investmentTotal,
      totalPence: liquidTotal + investmentTotal,
      belowEmergency: liquidTotal < input.emergencyFundPence,
      inflowBreakdown,
      outflowBreakdown,
    })
  }

  return pts
}

// --------------------------------------------------------------------------
// Runway
// --------------------------------------------------------------------------

export function summariseRunway(
  trajectory: MonthlyPoint[],
  emergencyFundPence: number,
  liquidNow: number,
  investmentNow: number,
  monthlyBurnPence: number,
): RunwaySummary {
  let monthsToFloor = Infinity
  let floorDate: string | null = null
  let monthsToZero = Infinity
  let zeroDate: string | null = null

  for (let i = 0; i < trajectory.length; i++) {
    const p = trajectory[i]!
    if (monthsToFloor === Infinity && p.liquidPence < emergencyFundPence) {
      monthsToFloor = i + 1
      floorDate = p.month
    }
    if (monthsToZero === Infinity && p.liquidPence < 0) {
      monthsToZero = i + 1
      zeroDate = p.month
    }
  }

  return {
    liquidPence: liquidNow,
    investmentPence: investmentNow,
    totalPence: liquidNow + investmentNow,
    emergencyFundPence,
    monthlyBurnPence,
    monthsToFloor,
    floorDate,
    monthsToZero,
    zeroDate,
  }
}

// --------------------------------------------------------------------------
// Budgets — actual vs target for the current month
// --------------------------------------------------------------------------

export interface BudgetStatus {
  budgetId: string
  categoryId: string
  monthlyTargetPence: number
  spentPence: number
  remainingPence: number
  /** Fraction of target spent (0..N). */
  pct: number
  projectedEndOfMonthPence: number
}

export function budgetStatusForMonth(
  budgets: Budget[],
  monthly: CategoryMonthlySpend[],
  month: string,
): BudgetStatus[] {
  const m = monthly.find((x) => x.month === month)?.byCategory ?? {}
  const today = new Date()
  const [y, mm] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y!, mm!, 0)).getUTCDate()
  const dayOfMonth = (today.getUTCFullYear() === y && today.getUTCMonth() + 1 === mm)
    ? today.getUTCDate()
    : daysInMonth
  const elapsedFraction = dayOfMonth / daysInMonth
  return budgets.map((b) => {
    const spent = m[b.categoryId] ?? 0
    const projected = elapsedFraction > 0 ? Math.round(spent / elapsedFraction) : spent
    return {
      budgetId: b.id,
      categoryId: b.categoryId,
      monthlyTargetPence: b.monthlyTargetPence,
      spentPence: spent,
      remainingPence: b.monthlyTargetPence - spent,
      pct: b.monthlyTargetPence > 0 ? spent / b.monthlyTargetPence : 0,
      projectedEndOfMonthPence: projected,
    }
  })
}

// --------------------------------------------------------------------------
// Shared-tab tracker
// --------------------------------------------------------------------------

export interface SharedTabBalance {
  /** Counterparty name (matches sharedWithCounterparty + Monzo counterparty). */
  counterparty: string
  /** Sum of `their_share` across shared outgoing transactions (positive = they owe you). */
  theyOwePence: number
  /** Sum of inbound transfers from this counterparty (their reimbursements + transfers from them). */
  theyPaidPence: number
  /** Net = theyOwePence - theyPaidPence. Positive: they still owe you. Negative: you owe them. */
  netOwedToYouPence: number
  /** Earliest unsettled transaction date. */
  oldestSharedDate: string | null
  /** Most recent shared activity. */
  latestSharedDate: string | null
  /** Sample shared outgoing txns (last 20). */
  sampleShared: Array<{ id: string; date: string; merchant: string; grossPence: number; theirSharePence: number }>
  /** Sample inbound reimbursements (last 20). */
  sampleReimbursements: Array<{ id: string; date: string; amountPence: number; note: string }>
}

/**
 * Compute outstanding shared-tab balances per counterparty. The user's net
 * cost on a shared transaction is `gross * sharedFraction`; the rest is
 * what the counterparty owes them. Inbound transfers from the same
 * counterparty are subtracted from that running total.
 *
 * Counterparty matching: rule's `sharedWithCounterparty` field (if set) is
 * the canonical key. Inbound transfers match by Monzo's `counterparty.name`
 * (case-insensitive, trimmed).
 */
export function computeSharedTabBalances(
  txns: MonzoTransaction[],
  rules: CategoryRule[],
  overrides: TxOverride[],
): SharedTabBalance[] {
  const balances = new Map<string, SharedTabBalance>()
  const ensure = (name: string): SharedTabBalance => {
    const key = name.toLowerCase().trim()
    let b = balances.get(key)
    if (!b) {
      b = {
        counterparty: name,
        theyOwePence: 0,
        theyPaidPence: 0,
        netOwedToYouPence: 0,
        oldestSharedDate: null,
        latestSharedDate: null,
        sampleShared: [],
        sampleReimbursements: [],
      }
      balances.set(key, b)
    }
    return b
  }

  for (const tx of txns) {
    if (tx.decline_reason) continue
    const eff = effectiveCategory(tx, rules, overrides)
    if (eff.ignored) continue

    const counterparty = (tx as unknown as { counterparty?: { name?: string } }).counterparty?.name ?? ''

    // Inbound reimbursement: positive amount + counterparty matches some
    // tracked sharedWithCounterparty. Excludes inbound flows already
    // categorised as a real income stream (e.g. "Veronica's £825/mo rent
    // share" — that's modelled as cat_other_income elsewhere; counting it
    // here would double-claim it as a shared-tab settlement).
    if (tx.amount > 0 && counterparty) {
      const tracked = [
        ...rules.filter((r) => r.sharedWithCounterparty?.toLowerCase() === counterparty.toLowerCase()),
        ...overrides.filter((o) => o.sharedWithCounterparty?.toLowerCase() === counterparty.toLowerCase()),
      ]
      const cat = eff.categoryId
      const isProperIncome = cat === 'cat_salary' || cat === 'cat_other_income'
      if (tracked.length > 0 && !isProperIncome) {
        const b = ensure(counterparty)
        b.theyPaidPence += tx.amount
        const date = tx.created.slice(0, 10)
        b.latestSharedDate = b.latestSharedDate && b.latestSharedDate >= date ? b.latestSharedDate : date
        b.sampleReimbursements.push({ id: tx.id, date, amountPence: tx.amount, note: tx.notes || tx.description || '' })
      }
      continue
    }

    // Shared outgoing: sharedFraction < 1 means part of it is owed back
    if (eff.sharedFraction < 1 && eff.sharedWithCounterparty && tx.amount < 0) {
      const b = ensure(eff.sharedWithCounterparty)
      const gross = -tx.amount
      const theirShare = Math.round(gross * (1 - eff.sharedFraction))
      b.theyOwePence += theirShare
      const date = tx.created.slice(0, 10)
      if (!b.oldestSharedDate || date < b.oldestSharedDate) b.oldestSharedDate = date
      if (!b.latestSharedDate || date > b.latestSharedDate) b.latestSharedDate = date
      const merchant = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant.name : (tx.description || '')
      b.sampleShared.push({ id: tx.id, date, merchant, grossPence: gross, theirSharePence: theirShare })
    }
  }

  for (const b of balances.values()) {
    b.netOwedToYouPence = b.theyOwePence - b.theyPaidPence
    b.sampleShared = b.sampleShared.sort((a, c) => c.date.localeCompare(a.date)).slice(0, 20)
    b.sampleReimbursements = b.sampleReimbursements.sort((a, c) => c.date.localeCompare(a.date)).slice(0, 20)
  }
  return Array.from(balances.values()).sort((a, b) => Math.abs(b.netOwedToYouPence) - Math.abs(a.netOwedToYouPence))
}

// --------------------------------------------------------------------------
// Recurring detection
// --------------------------------------------------------------------------

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

/**
 * Detect transactions that recur monthly with similar amounts. Heuristic:
 * group by (merchant or counterparty or normalized description, amount-band),
 * require ≥3 occurrences spread across ≥3 distinct months.
 */
export function detectRecurring(txns: MonzoTransaction[]): RecurringCandidate[] {
  const groups = new Map<string, MonzoTransaction[]>()
  for (const tx of txns) {
    if (tx.decline_reason) continue
    const merchant = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant.name : ''
    const counterparty = (tx as any).counterparty?.name ?? ''
    const label = merchant || counterparty || tx.description.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!label) continue
    // Round amount to nearest 50p to group near-identical (subscriptions creep)
    const band = Math.round(tx.amount / 50) * 50
    const key = `${label.toLowerCase()}|${band}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(tx)
  }
  const out: RecurringCandidate[] = []
  for (const [key, list] of groups) {
    if (list.length < 3) continue
    const months = new Set(list.map((t) => t.created.slice(0, 7)))
    if (months.size < 3) continue
    const sample = list[0]!
    const merchant = typeof sample.merchant === 'object' && sample.merchant ? sample.merchant.name : ''
    const counterparty = (sample as any).counterparty?.name ?? ''
    const label = merchant || counterparty || sample.description
    const amt = Math.round(list.reduce((a, t) => a + t.amount, 0) / list.length)
    out.push({
      key,
      label,
      amountPence: Math.abs(amt),
      cadence: 'monthly',
      occurrences: list.length,
      lastSeen: list.map((t) => t.created).sort().reverse()[0]!.slice(0, 10),
      sample: { txId: sample.id },
      suggestedKind: amt >= 0 ? 'income' : 'expense',
    })
  }
  return out.sort((a, b) => b.occurrences - a.occurrences)
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

export function enumerateMonths(startMonth: string, count: number): string[] {
  const [y, m] = startMonth.split('-').map(Number)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y!, (m! - 1) + i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

export function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function emergencyFundPence(settings: FinanceSettings, monthlyBurnPence: number): number {
  if (settings.emergencyFund.mode === 'fixed') return settings.emergencyFund.valuePence
  return Math.round(Math.abs(monthlyBurnPence) * settings.emergencyFund.months)
}
