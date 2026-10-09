import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FinanceStore } from '../finance/store.js'

// What a client sends over JSON: `undefined` keys are gone, `null` survives.
const wire = <T>(body: T): T => JSON.parse(JSON.stringify(body)) as T

let dir: string
const onDisk = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>[]

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'finance-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('create keeps every field the client sent', () => {
  it('account: growthPctYoy and archived', () => {
    const store = new FinanceStore(dir)
    const acc = store.upsertAccount(wire({ name: 'ISA', type: 'manual' as const, liquidity: 'investment' as const, growthPctYoy: 6.5, archived: true }))
    expect(acc.growthPctYoy).toBe(6.5)
    expect(acc.archived).toBe(true)
    expect(onDisk('finance-accounts.json')[0]).toMatchObject({ growthPctYoy: 6.5, archived: true })
  })

  it('rule: the shared split', () => {
    const store = new FinanceStore(dir)
    const rule = store.upsertRule(wire({ id: 'rule_new', categoryId: 'cat_groceries', match: { merchantContains: 'tesco' }, sharedFraction: 0.5, sharedWithCounterparty: 'Sam' }))
    expect(rule.sharedFraction).toBe(0.5)
    expect(rule.sharedWithCounterparty).toBe('Sam')
  })

  it('stream and category: archived', () => {
    const store = new FinanceStore(dir)
    const stream = store.upsertStream(wire({ name: 'Old rent', kind: 'expense' as const, amountPence: 100_00, cadence: 'monthly' as const, startDate: '2026-01-01', archived: true }))
    expect(stream.archived).toBe(true)
    const cat = store.upsertCategory(wire({ name: 'Retired', archived: true }))
    expect(cat.archived).toBe(true)
  })
})

describe('null clears a field on an edit', () => {
  it('account: emptied notes, emoji and growth go away, the rest stays', () => {
    const store = new FinanceStore(dir)
    const acc = store.upsertAccount(wire({ name: 'Savings', type: 'manual' as const, liquidity: 'liquid' as const, emoji: '🏦', notes: 'old note', growthPctYoy: 3.25, isExternal: true }))
    // The PATCH route's shape: the stored record under the client's patch.
    const patch = wire({ name: 'Savings', emoji: null, notes: null, growthPctYoy: null })
    const edited = store.upsertAccount({ ...acc, ...(patch as object), id: acc.id })
    expect(edited.name).toBe('Savings')
    expect(edited.isExternal).toBe(true)
    expect('emoji' in edited).toBe(false)
    expect('notes' in edited).toBe(false)
    expect('growthPctYoy' in edited).toBe(false)
    const stored = onDisk('finance-accounts.json')[0]!
    expect(Object.values(stored)).not.toContain(null)
    expect(stored.isExternal).toBe(true)
  })

  it('a key the client left out is untouched', () => {
    const store = new FinanceStore(dir)
    const acc = store.upsertAccount(wire({ name: 'Savings', type: 'manual' as const, liquidity: 'liquid' as const, notes: 'keep me', growthPctYoy: 3.25 }))
    const edited = store.upsertAccount({ ...acc, ...wire({ name: 'Renamed', notes: undefined }), id: acc.id })
    expect(edited.name).toBe('Renamed')
    expect(edited.notes).toBe('keep me')
    expect(edited.growthPctYoy).toBe(3.25)
  })

  it('rule: un-ignoring and dropping the split', () => {
    const store = new FinanceStore(dir)
    const rule = store.upsertRule(wire({ id: 'rule_x', categoryId: 'cat_groceries', match: {}, label: 'Shared shop', ignore: true, asTransfer: true, sharedFraction: 0.5, sharedWithCounterparty: 'Sam' }))
    const edited = store.upsertRule({ ...rule, ...(wire({ ignore: null, asTransfer: null, sharedFraction: null, sharedWithCounterparty: null, label: null }) as object), id: rule.id })
    expect(edited.ignore).toBeUndefined()
    expect(edited.asTransfer).toBeUndefined()
    expect(edited.sharedFraction).toBeUndefined()
    expect(edited.sharedWithCounterparty).toBeUndefined()
    expect(edited.categoryId).toBe('cat_groceries')
    const stored = onDisk('finance-rules.json').find((r) => r.id === 'rule_x')!
    expect(Object.values(stored)).not.toContain(null)
  })

  it('stream: removing the end date', () => {
    const store = new FinanceStore(dir)
    const stream = store.upsertStream(wire({ name: 'Contract', kind: 'income' as const, amountPence: 5000_00, cadence: 'monthly' as const, startDate: '2026-01-01', endDate: '2026-12-31', categoryId: 'cat_salary' }))
    const edited = store.upsertStream({ ...stream, ...(wire({ endDate: null, categoryId: null }) as object), id: stream.id })
    expect(edited.endDate).toBeUndefined()
    expect(edited.categoryId).toBeUndefined()
    expect(edited.startDate).toBe('2026-01-01')
  })
})

describe('a record never holds a null', () => {
  it('a create that carries one stores no such key', () => {
    const store = new FinanceStore(dir)
    store.upsertAccount(wire({ id: 'acc_phone', name: 'Cash', type: 'manual' as const, liquidity: 'liquid' as const, emoji: null, growthPctYoy: null }) as never)
    expect(Object.values(onDisk('finance-accounts.json')[0]!)).not.toContain(null)
  })

  it('nulls an older hub stored are gone once the file is loaded', () => {
    writeFileSync(join(dir, 'finance-accounts.json'), JSON.stringify([
      { id: 'acc_old', name: 'Old', type: 'manual', liquidity: 'liquid', currency: 'GBP', emoji: null, growthPctYoy: null, ledger: [] },
    ]))
    const store = new FinanceStore(dir)
    const acc = store.getAccount('acc_old')!
    expect('emoji' in acc).toBe(false)
    expect('growthPctYoy' in acc).toBe(false)
    expect(acc.ledger).toEqual([])
  })
})

describe('an account edit cannot replace the balance history', () => {
  it('a ledger riding the edit is ignored', () => {
    const store = new FinanceStore(dir)
    const acc = store.upsertAccount(wire({ name: 'Savings', type: 'manual' as const, liquidity: 'liquid' as const }))
    const stale = wire(acc)                                   // the client's copy, taken now
    store.addBalanceEntry(acc.id, { date: '2026-10-01', balancePence: 1000_00 })
    store.upsertAccount({ ...stale, name: 'Renamed' })        // …and sent back after the hub moved on
    const after = store.getAccount(acc.id)!
    expect(after.name).toBe('Renamed')
    expect(after.ledger).toHaveLength(1)
    expect(after.ledger![0]!.balancePence).toBe(1000_00)
  })
})
