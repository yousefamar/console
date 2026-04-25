// Finance store — persists categories, rules, accounts, streams, budgets,
// scenarios, transaction overrides and settings to JSON files under
// ~/.config/console/. One class so callers don't have to coordinate writes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Account, BalanceEntry, Budget, Category, CategoryRule, FinanceSettings,
  Scenario, Stream, TxOverride, FinanceData,
} from './types.js'

const FILE_NAMES = {
  categories: 'finance-categories.json',
  rules: 'finance-rules.json',
  accounts: 'finance-accounts.json',
  streams: 'finance-streams.json',
  budgets: 'finance-budgets.json',
  scenarios: 'finance-scenarios.json',
  overrides: 'finance-tx-overrides.json',
  settings: 'finance-settings.json',
} as const

const DEFAULT_CATEGORIES: Category[] = [
  // System / default expense
  { id: 'cat_uncat', name: 'Uncategorised', emoji: '❓', color: '#94a3b8', kind: 'expense', isSystem: true, variable: true },
  { id: 'cat_transfer', name: 'Transfer', emoji: '🔁', color: '#475569', kind: 'transfer', isSystem: true },
  { id: 'cat_salary', name: 'Salary', emoji: '💼', color: '#10b981', kind: 'income' },
  { id: 'cat_other_income', name: 'Other income', emoji: '💰', color: '#22c55e', kind: 'income' },
  // Expense buckets — closer to user life than Monzo's 10 generic ones
  { id: 'cat_rent', name: 'Rent / mortgage', emoji: '🏠', color: '#ef4444', kind: 'expense', variable: false },
  { id: 'cat_bills', name: 'Bills & utilities', emoji: '💡', color: '#f97316', kind: 'expense', variable: false },
  { id: 'cat_groceries', name: 'Groceries', emoji: '🛒', color: '#84cc16', kind: 'expense', variable: true },
  { id: 'cat_eatingout', name: 'Eating out', emoji: '🍽️', color: '#f59e0b', kind: 'expense', variable: true },
  { id: 'cat_transport', name: 'Transport', emoji: '🚆', color: '#3b82f6', kind: 'expense', variable: true },
  { id: 'cat_shopping', name: 'Shopping', emoji: '🛍️', color: '#a855f7', kind: 'expense', variable: true },
  { id: 'cat_entertainment', name: 'Entertainment', emoji: '🎬', color: '#ec4899', kind: 'expense', variable: true },
  { id: 'cat_health', name: 'Health & fitness', emoji: '💪', color: '#06b6d4', kind: 'expense', variable: true },
  { id: 'cat_subscriptions', name: 'Subscriptions', emoji: '🔁', color: '#8b5cf6', kind: 'expense', variable: false },
  { id: 'cat_holidays', name: 'Holidays / travel', emoji: '✈️', color: '#0ea5e9', kind: 'expense', variable: true },
  { id: 'cat_savings', name: 'Savings / investing', emoji: '🪙', color: '#facc15', kind: 'expense', variable: false },
  { id: 'cat_gifts', name: 'Gifts & donations', emoji: '🎁', color: '#fb7185', kind: 'expense', variable: true },
]

const DEFAULT_RULES: CategoryRule[] = [
  { id: 'rule_monzo_groceries', priority: 100, label: 'Monzo: groceries', match: { monzoCategoryEquals: 'groceries' }, categoryId: 'cat_groceries' },
  { id: 'rule_monzo_eating_out', priority: 100, label: 'Monzo: eating out', match: { monzoCategoryEquals: 'eating_out' }, categoryId: 'cat_eatingout' },
  { id: 'rule_monzo_transport', priority: 100, label: 'Monzo: transport', match: { monzoCategoryEquals: 'transport' }, categoryId: 'cat_transport' },
  { id: 'rule_monzo_bills', priority: 100, label: 'Monzo: bills', match: { monzoCategoryEquals: 'bills' }, categoryId: 'cat_bills' },
  { id: 'rule_monzo_entertainment', priority: 100, label: 'Monzo: entertainment', match: { monzoCategoryEquals: 'entertainment' }, categoryId: 'cat_entertainment' },
  { id: 'rule_monzo_shopping', priority: 100, label: 'Monzo: shopping', match: { monzoCategoryEquals: 'shopping' }, categoryId: 'cat_shopping' },
  { id: 'rule_monzo_holidays', priority: 100, label: 'Monzo: holidays', match: { monzoCategoryEquals: 'holidays' }, categoryId: 'cat_holidays' },
  { id: 'rule_monzo_cash', priority: 100, label: 'Monzo: cash', match: { monzoCategoryEquals: 'cash' }, categoryId: 'cat_uncat' },
]

const DEFAULT_SETTINGS: FinanceSettings = {
  emergencyFund: { mode: 'months', months: 3 },
  projectionHorizonMonths: 24,
  homeCurrency: 'GBP',
  investmentGrowthPct: 5,
}

export class FinanceStore {
  private categories: Category[] = []
  private rules: CategoryRule[] = []
  private accounts: Account[] = []
  private streams: Stream[] = []
  private budgets: Budget[] = []
  private scenarios: Scenario[] = []
  private overrides: TxOverride[] = []
  private settings: FinanceSettings = { ...DEFAULT_SETTINGS }

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
    this.categories = this.loadFile(FILE_NAMES.categories, DEFAULT_CATEGORIES)
    this.rules = this.loadFile(FILE_NAMES.rules, DEFAULT_RULES)
    this.accounts = this.loadFile(FILE_NAMES.accounts, [] as Account[])
    this.streams = this.loadFile(FILE_NAMES.streams, [] as Stream[])
    this.budgets = this.loadFile(FILE_NAMES.budgets, [] as Budget[])
    this.scenarios = this.loadFile(FILE_NAMES.scenarios, [] as Scenario[])
    this.overrides = this.loadFile(FILE_NAMES.overrides, [] as TxOverride[])
    this.settings = this.loadFile(FILE_NAMES.settings, DEFAULT_SETTINGS)
  }

  private path(name: string): string { return join(this.dir, name) }

  private loadFile<T>(name: string, fallback: T): T {
    const p = this.path(name)
    if (!existsSync(p)) {
      this.writeFile(name, fallback)
      return fallback
    }
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T
    } catch (err) {
      console.error(`[finance] Failed to load ${name}:`, (err as Error).message)
      return fallback
    }
  }

  private writeFile(name: string, data: unknown): void {
    try {
      mkdirSync(dirname(this.path(name)), { recursive: true })
      writeFileSync(this.path(name), JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      console.error(`[finance] Failed to save ${name}:`, (err as Error).message)
    }
  }

  // --- Read accessors ------------------------------------------------------

  getAll(): FinanceData {
    return {
      categories: this.categories,
      rules: this.rules,
      accounts: this.accounts,
      streams: this.streams,
      budgets: this.budgets,
      scenarios: this.scenarios,
      overrides: this.overrides,
      settings: this.settings,
    }
  }

  getCategories(): Category[] { return this.categories }
  getCategory(id: string): Category | undefined { return this.categories.find((c) => c.id === id) }
  getRules(): CategoryRule[] { return this.rules }
  getAccounts(): Account[] { return this.accounts }
  getAccount(id: string): Account | undefined { return this.accounts.find((a) => a.id === id) }
  getStreams(): Stream[] { return this.streams }
  getBudgets(): Budget[] { return this.budgets }
  getScenarios(): Scenario[] { return this.scenarios }
  getScenario(id: string): Scenario | undefined { return this.scenarios.find((s) => s.id === id) }
  getOverrides(): TxOverride[] { return this.overrides }
  getOverride(txId: string): TxOverride | undefined { return this.overrides.find((o) => o.txId === txId) }
  getSettings(): FinanceSettings { return this.settings }

  // --- Categories ----------------------------------------------------------

  upsertCategory(input: Partial<Category> & { name: string }): Category {
    const existing = input.id ? this.categories.find((c) => c.id === input.id) : undefined
    if (existing) {
      Object.assign(existing, input)
    } else {
      const cat: Category = {
        id: input.id ?? `cat_${randomUUID().slice(0, 8)}`,
        name: input.name,
        emoji: input.emoji ?? '🏷️',
        color: input.color ?? '#94a3b8',
        kind: input.kind ?? 'expense',
        variable: input.variable ?? true,
      }
      this.categories.push(cat)
    }
    this.writeFile(FILE_NAMES.categories, this.categories)
    return existing ?? this.categories[this.categories.length - 1]!
  }

  deleteCategory(id: string): boolean {
    const cat = this.categories.find((c) => c.id === id)
    if (!cat) return false
    if (cat.isSystem) throw new Error('Cannot delete system category')
    this.categories = this.categories.filter((c) => c.id !== id)
    // Remove rules pointing to it
    this.rules = this.rules.filter((r) => r.categoryId !== id)
    // Clear from streams/budgets/overrides
    this.streams = this.streams.map((s) => s.categoryId === id ? { ...s, categoryId: undefined } : s)
    this.budgets = this.budgets.filter((b) => b.categoryId !== id)
    this.overrides = this.overrides.map((o) => o.categoryId === id ? { ...o, categoryId: undefined } : o)
    this.writeFile(FILE_NAMES.categories, this.categories)
    this.writeFile(FILE_NAMES.rules, this.rules)
    this.writeFile(FILE_NAMES.streams, this.streams)
    this.writeFile(FILE_NAMES.budgets, this.budgets)
    this.writeFile(FILE_NAMES.overrides, this.overrides)
    return true
  }

  // --- Rules ---------------------------------------------------------------

  upsertRule(input: Partial<CategoryRule> & { categoryId: string; match: CategoryRule['match'] }): CategoryRule {
    const existing = input.id ? this.rules.find((r) => r.id === input.id) : undefined
    if (existing) {
      Object.assign(existing, input)
    } else {
      const r: CategoryRule = {
        id: input.id ?? `rule_${randomUUID().slice(0, 8)}`,
        priority: input.priority ?? 50,
        label: input.label,
        match: input.match,
        categoryId: input.categoryId,
        ignore: input.ignore,
        asTransfer: input.asTransfer,
      }
      this.rules.push(r)
    }
    this.rules.sort((a, b) => a.priority - b.priority)
    this.writeFile(FILE_NAMES.rules, this.rules)
    return existing ?? this.rules.find((r) => r.id === input.id)!
  }

  deleteRule(id: string): boolean {
    const before = this.rules.length
    this.rules = this.rules.filter((r) => r.id !== id)
    if (this.rules.length === before) return false
    this.writeFile(FILE_NAMES.rules, this.rules)
    return true
  }

  // --- Accounts ------------------------------------------------------------

  upsertAccount(input: Partial<Account> & { name: string; type: Account['type']; liquidity: Account['liquidity'] }): Account {
    const existing = input.id ? this.accounts.find((a) => a.id === input.id) : undefined
    if (existing) {
      Object.assign(existing, input)
    } else {
      const acc: Account = {
        id: input.id ?? `acc_${randomUUID().slice(0, 8)}`,
        name: input.name,
        type: input.type,
        liquidity: input.liquidity,
        currency: input.currency ?? 'GBP',
        emoji: input.emoji,
        color: input.color,
        monzoAccountId: input.monzoAccountId,
        ledger: input.ledger ?? (input.type === 'manual' ? [] : undefined),
        isExternal: input.isExternal,
        sort: input.sort ?? this.accounts.length,
        notes: input.notes,
      }
      this.accounts.push(acc)
    }
    this.writeFile(FILE_NAMES.accounts, this.accounts)
    return existing ?? this.accounts[this.accounts.length - 1]!
  }

  deleteAccount(id: string): boolean {
    const before = this.accounts.length
    this.accounts = this.accounts.filter((a) => a.id !== id)
    if (this.accounts.length === before) return false
    // Clear from streams
    this.streams = this.streams.map((s) => s.accountId === id ? { ...s, accountId: undefined } : s)
    this.writeFile(FILE_NAMES.accounts, this.accounts)
    this.writeFile(FILE_NAMES.streams, this.streams)
    return true
  }

  addBalanceEntry(accountId: string, entry: { date: string; balancePence: number; note?: string }): BalanceEntry {
    const acc = this.accounts.find((a) => a.id === accountId)
    if (!acc) throw new Error(`Account ${accountId} not found`)
    if (acc.type !== 'manual') throw new Error('Balance entries only on manual accounts')
    const e: BalanceEntry = { id: `bal_${randomUUID().slice(0, 8)}`, ...entry }
    acc.ledger = acc.ledger ?? []
    acc.ledger.push(e)
    acc.ledger.sort((a, b) => a.date.localeCompare(b.date))
    this.writeFile(FILE_NAMES.accounts, this.accounts)
    return e
  }

  updateBalanceEntry(accountId: string, entryId: string, patch: Partial<Omit<BalanceEntry, 'id'>>): BalanceEntry | null {
    const acc = this.accounts.find((a) => a.id === accountId)
    if (!acc?.ledger) return null
    const idx = acc.ledger.findIndex((e) => e.id === entryId)
    if (idx < 0) return null
    acc.ledger[idx] = { ...acc.ledger[idx]!, ...patch }
    acc.ledger.sort((a, b) => a.date.localeCompare(b.date))
    this.writeFile(FILE_NAMES.accounts, this.accounts)
    return acc.ledger[idx]!
  }

  deleteBalanceEntry(accountId: string, entryId: string): boolean {
    const acc = this.accounts.find((a) => a.id === accountId)
    if (!acc?.ledger) return false
    const before = acc.ledger.length
    acc.ledger = acc.ledger.filter((e) => e.id !== entryId)
    if (acc.ledger.length === before) return false
    this.writeFile(FILE_NAMES.accounts, this.accounts)
    return true
  }

  // --- Streams -------------------------------------------------------------

  upsertStream(input: Partial<Stream> & { name: string; kind: Stream['kind']; amountPence: number; cadence: Stream['cadence']; startDate: string }): Stream {
    const existing = input.id ? this.streams.find((s) => s.id === input.id) : undefined
    if (existing) {
      Object.assign(existing, input)
    } else {
      const s: Stream = {
        id: input.id ?? `str_${randomUUID().slice(0, 8)}`,
        name: input.name,
        kind: input.kind,
        amountPence: input.amountPence,
        cadence: input.cadence,
        dayOfMonth: input.dayOfMonth,
        monthOfYear: input.monthOfYear,
        startDate: input.startDate,
        endDate: input.endDate,
        categoryId: input.categoryId,
        accountId: input.accountId,
        growthPctYoy: input.growthPctYoy,
        notes: input.notes,
      }
      this.streams.push(s)
    }
    this.writeFile(FILE_NAMES.streams, this.streams)
    return existing ?? this.streams[this.streams.length - 1]!
  }

  deleteStream(id: string): boolean {
    const before = this.streams.length
    this.streams = this.streams.filter((s) => s.id !== id)
    if (this.streams.length === before) return false
    this.writeFile(FILE_NAMES.streams, this.streams)
    return true
  }

  // --- Budgets -------------------------------------------------------------

  upsertBudget(input: Partial<Budget> & { categoryId: string; monthlyTargetPence: number }): Budget {
    const existing = input.id
      ? this.budgets.find((b) => b.id === input.id)
      : this.budgets.find((b) => b.categoryId === input.categoryId)
    if (existing) {
      Object.assign(existing, input)
    } else {
      const b: Budget = {
        id: input.id ?? `bud_${randomUUID().slice(0, 8)}`,
        categoryId: input.categoryId,
        monthlyTargetPence: input.monthlyTargetPence,
        rollover: input.rollover,
        notes: input.notes,
      }
      this.budgets.push(b)
    }
    this.writeFile(FILE_NAMES.budgets, this.budgets)
    return existing ?? this.budgets[this.budgets.length - 1]!
  }

  deleteBudget(id: string): boolean {
    const before = this.budgets.length
    this.budgets = this.budgets.filter((b) => b.id !== id)
    if (this.budgets.length === before) return false
    this.writeFile(FILE_NAMES.budgets, this.budgets)
    return true
  }

  // --- Scenarios -----------------------------------------------------------

  upsertScenario(input: Partial<Scenario> & { name: string }): Scenario {
    const existing = input.id ? this.scenarios.find((s) => s.id === input.id) : undefined
    const now = new Date().toISOString()
    if (existing) {
      Object.assign(existing, input, { updatedAt: now })
    } else {
      const s: Scenario = {
        id: input.id ?? `scn_${randomUUID().slice(0, 8)}`,
        name: input.name,
        description: input.description,
        deltas: input.deltas ?? [],
        horizonMonths: input.horizonMonths,
        createdAt: now,
        updatedAt: now,
      }
      this.scenarios.push(s)
    }
    this.writeFile(FILE_NAMES.scenarios, this.scenarios)
    return existing ?? this.scenarios[this.scenarios.length - 1]!
  }

  deleteScenario(id: string): boolean {
    const before = this.scenarios.length
    this.scenarios = this.scenarios.filter((s) => s.id !== id)
    if (this.scenarios.length === before) return false
    this.writeFile(FILE_NAMES.scenarios, this.scenarios)
    return true
  }

  // --- Tx overrides --------------------------------------------------------

  upsertOverride(input: TxOverride): TxOverride {
    const idx = this.overrides.findIndex((o) => o.txId === input.txId)
    if (idx >= 0) {
      this.overrides[idx] = { ...this.overrides[idx]!, ...input }
    } else {
      this.overrides.push(input)
    }
    this.writeFile(FILE_NAMES.overrides, this.overrides)
    return this.overrides.find((o) => o.txId === input.txId)!
  }

  deleteOverride(txId: string): boolean {
    const before = this.overrides.length
    this.overrides = this.overrides.filter((o) => o.txId !== txId)
    if (this.overrides.length === before) return false
    this.writeFile(FILE_NAMES.overrides, this.overrides)
    return true
  }

  bulkUpsertOverrides(items: TxOverride[]): void {
    for (const o of items) {
      const idx = this.overrides.findIndex((x) => x.txId === o.txId)
      if (idx >= 0) this.overrides[idx] = { ...this.overrides[idx]!, ...o }
      else this.overrides.push(o)
    }
    this.writeFile(FILE_NAMES.overrides, this.overrides)
  }

  // --- Settings ------------------------------------------------------------

  updateSettings(patch: Partial<FinanceSettings>): FinanceSettings {
    this.settings = { ...this.settings, ...patch }
    this.writeFile(FILE_NAMES.settings, this.settings)
    return this.settings
  }
}
