// Finance routes — categories, rules, accounts, streams, budgets, scenarios,
// transaction overrides, settings; plus computed: net worth, projection,
// runway, monthly aggregation, recurring detection.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FinanceStore } from '../finance/store.js'
import type { MonzoStore } from '../monzo-store.js'
import type { MonzoClient, MonzoTransaction } from '../monzo-client.js'
import type { AuthStore } from '../auth-store.js'
import type {
  Account, Budget, Category, CategoryRule, Scenario, Stream, TxOverride,
  MonthlyPoint, RunwaySummary,
} from '../finance/types.js'
import {
  effectiveCategory, aggregateMonthlySpend, trailingCategoryAverage,
  trailingBurn, project, summariseRunway, computeNetWorthOn, netWorthHistory,
  manualBalanceLookup, currentMonth, emergencyFundPence,
  detectRecurring, findTransferCandidates, budgetStatusForMonth,
} from '../finance/projection.js'
import { importCsv } from '../finance/csv-import.js'
import { detectAccountCandidates } from '../finance/account-detect.js'
import { readFileSync } from 'node:fs'

export function handleFinanceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  finance: FinanceStore,
  monzoStore: MonzoStore,
  monzoClient: MonzoClient,
  authStore: AuthStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const error = (status: number, msg: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: msg }))
  }

  // ---- Bulk read --------------------------------------------------------
  if (path === '/finance/all' && req.method === 'GET') {
    json(finance.getAll())
    return true
  }

  if (path === '/finance/settings' && req.method === 'GET') {
    json(finance.getSettings())
    return true
  }
  if (path === '/finance/settings' && req.method === 'PATCH') {
    readBody(req).then((body) => {
      const patch = JSON.parse(body)
      json(finance.updateSettings(patch))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }

  // ---- Categories -------------------------------------------------------
  if (path === '/finance/categories' && req.method === 'GET') {
    json(finance.getCategories()); return true
  }
  if (path === '/finance/categories' && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as Partial<Category> & { name: string }
      json(finance.upsertCategory(input))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const catMatch = path.match(/^\/finance\/categories\/([^/]+)$/)
  if (catMatch && req.method === 'PATCH') {
    readBody(req).then((b) => {
      const patch = JSON.parse(b) as Partial<Category>
      json(finance.upsertCategory({ id: catMatch[1]!, name: finance.getCategory(catMatch[1]!)?.name ?? 'Untitled', ...patch }))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  if (catMatch && req.method === 'DELETE') {
    try { finance.deleteCategory(catMatch[1]!); json({ ok: true }) }
    catch (e) { error(400, (e as Error).message) }
    return true
  }

  // ---- Rules ------------------------------------------------------------
  if (path === '/finance/rules' && req.method === 'GET') {
    json(finance.getRules()); return true
  }
  if (path === '/finance/rules' && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as Partial<CategoryRule> & { categoryId: string; match: CategoryRule['match'] }
      json(finance.upsertRule(input))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const ruleMatch = path.match(/^\/finance\/rules\/([^/]+)$/)
  if (ruleMatch && req.method === 'PATCH') {
    readBody(req).then((b) => {
      const patch = JSON.parse(b) as Partial<CategoryRule>
      const existing = finance.getRules().find((r) => r.id === ruleMatch[1])
      if (!existing) return error(404, 'Rule not found')
      json(finance.upsertRule({ ...existing, ...patch, id: ruleMatch[1]! }))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  if (ruleMatch && req.method === 'DELETE') {
    if (finance.deleteRule(ruleMatch[1]!)) json({ ok: true })
    else error(404, 'Rule not found')
    return true
  }

  // ---- Accounts ---------------------------------------------------------
  if (path === '/finance/accounts' && req.method === 'GET') {
    json(finance.getAccounts()); return true
  }
  if (path === '/finance/accounts' && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as Partial<Account> & { name: string; type: Account['type']; liquidity: Account['liquidity'] }
      json(finance.upsertAccount(input))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const accMatch = path.match(/^\/finance\/accounts\/([^/]+)$/)
  if (accMatch && req.method === 'PATCH') {
    readBody(req).then((b) => {
      const patch = JSON.parse(b) as Partial<Account>
      const existing = finance.getAccount(accMatch[1]!)
      if (!existing) return error(404, 'Account not found')
      json(finance.upsertAccount({ ...existing, ...patch, id: accMatch[1]! }))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  if (accMatch && req.method === 'DELETE') {
    if (finance.deleteAccount(accMatch[1]!)) json({ ok: true })
    else error(404, 'Account not found')
    return true
  }
  const ledgerMatch = path.match(/^\/finance\/accounts\/([^/]+)\/balance$/)
  if (ledgerMatch && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as { date: string; balancePence: number; note?: string }
      json(finance.addBalanceEntry(ledgerMatch[1]!, input))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const ledgerEntryMatch = path.match(/^\/finance\/accounts\/([^/]+)\/balance\/([^/]+)$/)
  if (ledgerEntryMatch && req.method === 'PATCH') {
    readBody(req).then((b) => {
      const patch = JSON.parse(b)
      const updated = finance.updateBalanceEntry(ledgerEntryMatch[1]!, ledgerEntryMatch[2]!, patch)
      if (updated) json(updated); else error(404, 'Entry not found')
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  if (ledgerEntryMatch && req.method === 'DELETE') {
    if (finance.deleteBalanceEntry(ledgerEntryMatch[1]!, ledgerEntryMatch[2]!)) json({ ok: true })
    else error(404, 'Entry not found')
    return true
  }

  // ---- Streams ----------------------------------------------------------
  if (path === '/finance/streams' && req.method === 'GET') {
    json(finance.getStreams()); return true
  }
  if (path === '/finance/streams' && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as Partial<Stream> & { name: string; kind: Stream['kind']; amountPence: number; cadence: Stream['cadence']; startDate: string }
      json(finance.upsertStream(input))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const streamMatch = path.match(/^\/finance\/streams\/([^/]+)$/)
  if (streamMatch && req.method === 'PATCH') {
    readBody(req).then((b) => {
      const patch = JSON.parse(b) as Partial<Stream>
      const existing = finance.getStreams().find((s) => s.id === streamMatch[1])
      if (!existing) return error(404, 'Stream not found')
      json(finance.upsertStream({ ...existing, ...patch, id: streamMatch[1]! }))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  if (streamMatch && req.method === 'DELETE') {
    if (finance.deleteStream(streamMatch[1]!)) json({ ok: true })
    else error(404, 'Stream not found')
    return true
  }

  // ---- Budgets ----------------------------------------------------------
  if (path === '/finance/budgets' && req.method === 'GET') {
    json(finance.getBudgets()); return true
  }
  if (path === '/finance/budgets' && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as Partial<Budget> & { categoryId: string; monthlyTargetPence: number }
      json(finance.upsertBudget(input))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const budgetMatch = path.match(/^\/finance\/budgets\/([^/]+)$/)
  if (budgetMatch && req.method === 'DELETE') {
    if (finance.deleteBudget(budgetMatch[1]!)) json({ ok: true })
    else error(404, 'Budget not found')
    return true
  }

  // ---- Scenarios --------------------------------------------------------
  if (path === '/finance/scenarios' && req.method === 'GET') {
    json(finance.getScenarios()); return true
  }
  if (path === '/finance/scenarios' && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as Partial<Scenario> & { name: string }
      json(finance.upsertScenario(input))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const scnMatch = path.match(/^\/finance\/scenarios\/([^/]+)$/)
  if (scnMatch && req.method === 'PATCH') {
    readBody(req).then((b) => {
      const patch = JSON.parse(b) as Partial<Scenario>
      const existing = finance.getScenario(scnMatch[1]!)
      if (!existing) return error(404, 'Scenario not found')
      json(finance.upsertScenario({ ...existing, ...patch, id: scnMatch[1]! }))
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  if (scnMatch && req.method === 'DELETE') {
    if (finance.deleteScenario(scnMatch[1]!)) json({ ok: true })
    else error(404, 'Scenario not found')
    return true
  }

  // ---- Tx overrides -----------------------------------------------------
  if (path === '/finance/overrides' && req.method === 'GET') {
    json(finance.getOverrides()); return true
  }
  if (path === '/finance/overrides' && req.method === 'POST') {
    readBody(req).then((b) => {
      const input = JSON.parse(b) as TxOverride | TxOverride[]
      if (Array.isArray(input)) { finance.bulkUpsertOverrides(input); json({ ok: true, count: input.length }) }
      else { json(finance.upsertOverride(input)) }
    }).catch((e) => error(400, (e as Error).message))
    return true
  }
  const ovMatch = path.match(/^\/finance\/overrides\/([^/]+)$/)
  if (ovMatch && req.method === 'DELETE') {
    if (finance.deleteOverride(ovMatch[1]!)) json({ ok: true })
    else error(404, 'Override not found')
    return true
  }

  // ---- Computed: monthly aggregation -----------------------------------
  if (path === '/finance/monthly' && req.method === 'GET') {
    const txns = monzoStore.getTransactions({ limit: 100000 })
    const monthly = aggregateMonthlySpend(txns, finance.getRules(), finance.getOverrides())
    json(monthly)
    return true
  }

  // ---- Computed: variable forecast --------------------------------------
  if (path === '/finance/variable-forecast' && req.method === 'GET') {
    const window = parseInt(url.searchParams.get('window') ?? '3', 10)
    const txns = monzoStore.getTransactions({ limit: 100000 })
    const monthly = aggregateMonthlySpend(txns, finance.getRules(), finance.getOverrides())
    json(trailingCategoryAverage(monthly, window))
    return true
  }

  // ---- Computed: net worth ----------------------------------------------
  if (path === '/finance/networth' && req.method === 'GET') {
    const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10)
    buildNetWorthSnapshot(date, finance, monzoStore, monzoClient, authStore).then(json).catch((e) => error(500, (e as Error).message))
    return true
  }
  if (path === '/finance/networth/history' && req.method === 'GET') {
    const months = parseInt(url.searchParams.get('months') ?? '12', 10)
    buildNetWorthHistory(months, finance, monzoStore, monzoClient, authStore).then(json).catch((e) => error(500, (e as Error).message))
    return true
  }

  // ---- Computed: projection / runway ------------------------------------
  if (path === '/finance/projection' && req.method === 'GET') {
    const horizon = parseInt(url.searchParams.get('horizon') ?? String(finance.getSettings().projectionHorizonMonths), 10)
    const scenarioId = url.searchParams.get('scenario')
    const window = parseInt(url.searchParams.get('window') ?? '3', 10)
    runProjection(horizon, scenarioId, window, finance, monzoStore, monzoClient, authStore)
      .then(json)
      .catch((e) => error(500, (e as Error).message))
    return true
  }

  // ---- Computed: budget status ------------------------------------------
  if (path === '/finance/budget-status' && req.method === 'GET') {
    const month = url.searchParams.get('month') ?? currentMonth()
    const txns = monzoStore.getTransactions({ limit: 100000 })
    const monthly = aggregateMonthlySpend(txns, finance.getRules(), finance.getOverrides())
    json(budgetStatusForMonth(finance.getBudgets(), monthly, month))
    return true
  }

  // ---- Computed: recurring detection ------------------------------------
  if (path === '/finance/recurring/candidates' && req.method === 'GET') {
    const txns = monzoStore.getTransactions({ limit: 100000 })
    json(detectRecurring(txns))
    return true
  }

  // ---- Computed: transfer candidates ------------------------------------
  if (path === '/finance/transfers/candidates' && req.method === 'GET') {
    const txns = monzoStore.getTransactions({ limit: 100000 })
    json(findTransferCandidates(txns, finance.getOverrides()))
    return true
  }

  // ---- CSV import (Monzo data export) -----------------------------------
  // Two body shapes: { csv: string } (full text) or { path: string } (server-
  // local path; useful for big files via CLI).
  if (path === '/finance/import/monzo-csv' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const payload = JSON.parse(body) as { csv?: string; path?: string; overwrite?: boolean }
      const csvText = payload.csv ?? (payload.path ? readFileSync(payload.path, 'utf8') : '')
      if (!csvText) return error(400, 'Provide csv (text) or path (server-local)')
      const monzo = authStore.getMonzoConfig()
      let accountId = monzo?.accountId
      if (!accountId) {
        try {
          const accounts = await monzoClient.getAccounts('uk_retail')
          if (accounts.length > 0) accountId = accounts[0]!.id
        } catch { /* fall through */ }
      }
      if (!accountId) accountId = 'csv_import'
      const { txs, summary } = importCsv(csvText, accountId)
      const merged = monzoStore.bulkMerge(txs)
      json({ ...summary, ...merged })
    }).catch((e) => error(400, (e as Error).message))
    return true
  }

  // ---- Account-candidate detection -------------------------------------
  if (path === '/finance/import/account-candidates' && req.method === 'GET') {
    const txns = monzoStore.getTransactions({ limit: 1_000_000 })
    json(detectAccountCandidates(txns))
    return true
  }

  // ---- Apply a candidate: create the manual account + ledger entries ----
  if (path === '/finance/import/apply-candidate' && req.method === 'POST') {
    readBody(req).then((body) => {
      const input = JSON.parse(body) as {
        key: string; name: string; liquidity: 'liquid' | 'investment' | 'illiquid';
        isExternal?: boolean; emoji?: string;
        ledger: Array<{ date: string; balancePence: number; note?: string }>;
      }
      const acc = finance.upsertAccount({
        name: input.name,
        type: 'manual',
        liquidity: input.liquidity,
        currency: 'GBP',
        emoji: input.emoji,
        isExternal: input.isExternal,
      })
      for (const e of input.ledger) {
        finance.addBalanceEntry(acc.id, e)
      }
      json({ accountId: acc.id, ledgerEntries: input.ledger.length })
    }).catch((e) => error(400, (e as Error).message))
    return true
  }

  // ---- Categorise transactions in batch (for transactions list) ---------
  if (path === '/finance/categorise' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') ?? '500', 10)
    const txns = monzoStore.getTransactions({ limit })
    const rules = finance.getRules()
    const overrides = finance.getOverrides()
    const out: Record<string, { categoryId: string; ignored: boolean; isTransfer: boolean }> = {}
    for (const tx of txns) out[tx.id] = effectiveCategory(tx, rules, overrides)
    json(out)
    return true
  }

  return false
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function getMonzoLiveBalance(
  monzoClient: MonzoClient,
  authStore: AuthStore,
): Promise<number | null> {
  const monzo = authStore.getMonzoConfig()
  if (!monzo?.accessToken) return null
  let accountId = monzo.accountId
  if (!accountId) {
    try {
      const accounts = await monzoClient.getAccounts('uk_retail')
      if (accounts.length > 0) {
        accountId = accounts[0]!.id
        authStore.setMonzoAccountId(accountId)
      } else return null
    } catch { return null }
  }
  try {
    const bal = await monzoClient.getBalance(accountId)
    return bal.total_balance // includes pots — counts as liquid
  } catch { return null }
}

/**
 * Resolve an account's balance on a date.
 * - Manual: use the ledger lookup.
 * - Monzo: live total balance for "today"; for past dates, walk the cached
 *   transactions backward from current balance to reconstruct.
 */
async function buildAccountBalanceFn(
  finance: FinanceStore,
  monzoStore: MonzoStore,
  monzoClient: MonzoClient,
  authStore: AuthStore,
): Promise<(accountId: string, date: string) => number> {
  const accounts = finance.getAccounts()
  const monzoAccount = accounts.find((a) => a.type === 'monzo')
  let monzoLive: number | null = null
  if (monzoAccount) monzoLive = await getMonzoLiveBalance(monzoClient, authStore)

  const monzoTxns: MonzoTransaction[] = monzoAccount ? monzoStore.getTransactions({ limit: 100000 }) : []

  return (accountId: string, date: string): number => {
    const acc = accounts.find((a) => a.id === accountId)
    if (!acc) return 0
    if (acc.type === 'manual') return manualBalanceLookup(acc).on(date)
    // Monzo
    if (monzoLive == null) return 0
    const today = new Date().toISOString().slice(0, 10)
    if (date >= today) return monzoLive
    let bal = monzoLive
    for (const tx of monzoTxns) {
      if (tx.decline_reason) continue
      if (tx.created.slice(0, 10) > date) bal -= tx.amount
    }
    return bal
  }
}

async function buildNetWorthSnapshot(
  date: string, finance: FinanceStore, monzoStore: MonzoStore,
  monzoClient: MonzoClient, authStore: AuthStore,
) {
  const balanceFor = await buildAccountBalanceFn(finance, monzoStore, monzoClient, authStore)
  return computeNetWorthOn(date, { accounts: finance.getAccounts(), balanceFor })
}

async function buildNetWorthHistory(
  months: number, finance: FinanceStore, monzoStore: MonzoStore,
  monzoClient: MonzoClient, authStore: AuthStore,
) {
  const balanceFor = await buildAccountBalanceFn(finance, monzoStore, monzoClient, authStore)
  const now = new Date()
  const monthStrs: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    monthStrs.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return netWorthHistory(monthStrs, { accounts: finance.getAccounts(), balanceFor })
}

async function runProjection(
  horizon: number, scenarioId: string | null, window: number,
  finance: FinanceStore, monzoStore: MonzoStore,
  monzoClient: MonzoClient, authStore: AuthStore,
): Promise<{ trajectory: MonthlyPoint[]; runway: RunwaySummary; emergencyFundPence: number }> {
  const txns = monzoStore.getTransactions({ limit: 100000 })
  const monthly = aggregateMonthlySpend(txns, finance.getRules(), finance.getOverrides())
  const variableForecast = trailingCategoryAverage(monthly, window)
  const burn = trailingBurn(txns, finance.getRules(), finance.getOverrides(), window)

  const balanceFor = await buildAccountBalanceFn(finance, monzoStore, monzoClient, authStore)
  const today = new Date().toISOString().slice(0, 10)
  const accounts = finance.getAccounts()
  let liquid = 0, investment = 0
  for (const acc of accounts) {
    if (acc.archived) continue
    const bal = balanceFor(acc.id, today)
    if (acc.liquidity === 'liquid') liquid += bal
    else if (acc.liquidity === 'investment') investment += bal
  }

  const settings = finance.getSettings()
  const fund = emergencyFundPence(settings, burn)
  const scenario = scenarioId ? finance.getScenario(scenarioId) ?? null : null
  const trajectory = project({
    startMonth: currentMonth(),
    horizonMonths: horizon,
    openingLiquidPence: liquid,
    openingInvestmentPence: investment,
    streams: finance.getStreams(),
    variableForecast,
    categories: finance.getCategories(),
    emergencyFundPence: fund,
    investmentGrowthPct: settings.investmentGrowthPct,
    scenario,
  })
  const runway = summariseRunway(trajectory, fund, liquid, investment, burn)
  return { trajectory, runway, emergencyFundPence: fund }
}
