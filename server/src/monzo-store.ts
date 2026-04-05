// Monzo transaction store — server-side cache
// Persists to ~/.config/console/monzo-transactions.json
// Handles full sync (5-min window after SCA) and incremental sync

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MonzoClient, MonzoTransaction } from './monzo-client.js'

interface MonzoCache {
  accountId: string
  transactions: MonzoTransaction[]
  lastSyncTimestamp: string | null
  fullSyncComplete: boolean
}

const EMPTY_CACHE: MonzoCache = {
  accountId: '',
  transactions: [],
  lastSyncTimestamp: null,
  fullSyncComplete: false,
}

export class MonzoStore {
  private cache: MonzoCache
  private syncing = false

  constructor(
    private cachePath: string,
    private client: MonzoClient,
  ) {
    this.cache = this.load()
  }

  get isFullSyncComplete(): boolean {
    return this.cache.fullSyncComplete
  }

  get transactionCount(): number {
    return this.cache.transactions.length
  }

  get lastSync(): string | null {
    return this.cache.lastSyncTimestamp
  }

  // --------------------------------------------------------------------------
  // Full sync — must happen within 5 min of SCA approval
  // --------------------------------------------------------------------------

  async fullSync(
    accountId: string,
    onProgress?: (count: number) => void,
  ): Promise<void> {
    if (this.syncing) return
    this.syncing = true

    try {
      this.cache.accountId = accountId
      const allTxns: MonzoTransaction[] = []
      let before: string | undefined = undefined
      let page = 0

      console.log('[monzo] Starting full sync...')

      while (true) {
        let batch: MonzoTransaction[]
        try {
          batch = await this.client.listTransactions(accountId, {
            limit: 100,
            before,
            expand: ['merchant'],
          })
        } catch (err: any) {
          // 403 verification_required = hit the 90-day wall, stop gracefully
          if (err?.status === 403) {
            console.log(`[monzo] Full sync: hit 90-day limit at ${allTxns.length} transactions`)
            break
          }
          throw err
        }

        if (batch.length === 0) break

        allTxns.push(...batch)
        page++

        // Use oldest transaction's created as cursor for next page
        before = batch[batch.length - 1]!.created

        console.log(`[monzo] Full sync: ${allTxns.length} transactions (page ${page})`)
        onProgress?.(allTxns.length)

        // Save every 500 transactions in case of crash
        if (allTxns.length % 500 < 100) {
          this.cache.transactions = allTxns.sort(
            (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
          )
          this.save()
        }

        // Small delay to avoid rate limiting
        await new Promise((r) => setTimeout(r, 200))
      }

      // Deduplicate by ID (pagination overlap when transactions share timestamps)
      const seen = new Map<string, MonzoTransaction>()
      for (const tx of allTxns) {
        seen.set(tx.id, tx)
      }
      // Sort newest first and save
      this.cache.transactions = Array.from(seen.values()).sort(
        (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
      )
      this.cache.fullSyncComplete = true
      this.cache.lastSyncTimestamp = new Date().toISOString()
      this.save()

      console.log(`[monzo] Full sync complete: ${allTxns.length} transactions`)
    } finally {
      this.syncing = false
    }
  }

  // --------------------------------------------------------------------------
  // Incremental sync — fetch new transactions since last known
  // --------------------------------------------------------------------------

  async incrementalSync(accountId: string): Promise<MonzoTransaction[]> {
    if (this.syncing) return []
    this.syncing = true

    try {
      // Use the most recent transaction's created timestamp as since
      const since = this.cache.transactions.length > 0
        ? this.cache.transactions[0]!.created
        : undefined

      const newTxns: MonzoTransaction[] = []
      let before: string | undefined = undefined

      while (true) {
        let batch: MonzoTransaction[]
        try {
          batch = await this.client.listTransactions(accountId, {
            limit: 100,
            since,
            before,
            expand: ['merchant'],
          })
        } catch (err: any) {
          if (err?.status === 403) break
          throw err
        }

        if (batch.length === 0) break
        newTxns.push(...batch)

        if (batch.length < 100) break // Last page
        before = batch[batch.length - 1]!.created

        await new Promise((r) => setTimeout(r, 200))
      }

      if (newTxns.length > 0) {
        // Deduplicate by ID
        const existingIds = new Set(this.cache.transactions.map((t) => t.id))
        const fresh = newTxns.filter((t) => !existingIds.has(t.id))

        if (fresh.length > 0) {
          this.cache.transactions.unshift(...fresh)
          // Re-sort newest first
          this.cache.transactions.sort(
            (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
          )
        }

        // Also update any existing transactions (e.g. settled status changed)
        for (const tx of newTxns) {
          if (existingIds.has(tx.id)) {
            const idx = this.cache.transactions.findIndex((t) => t.id === tx.id)
            if (idx >= 0) this.cache.transactions[idx] = tx
          }
        }

        this.cache.lastSyncTimestamp = new Date().toISOString()
        this.save()
        console.log(`[monzo] Incremental sync: ${fresh.length} new, ${newTxns.length - fresh.length} updated`)
        return fresh
      }

      this.cache.lastSyncTimestamp = new Date().toISOString()
      this.save()
      return []
    } finally {
      this.syncing = false
    }
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  getTransactions(opts: {
    since?: string
    before?: string
    category?: string
    search?: string
    limit?: number
    offset?: number
  } = {}): MonzoTransaction[] {
    let txns = this.cache.transactions

    if (opts.since) {
      const sinceTime = new Date(opts.since).getTime()
      txns = txns.filter((t) => new Date(t.created).getTime() >= sinceTime)
    }

    if (opts.before) {
      const beforeTime = new Date(opts.before).getTime()
      txns = txns.filter((t) => new Date(t.created).getTime() < beforeTime)
    }

    if (opts.category) {
      txns = txns.filter((t) => t.category === opts.category)
    }

    if (opts.search) {
      const q = opts.search.toLowerCase()
      txns = txns.filter((t) => {
        const merchantName = typeof t.merchant === 'object' && t.merchant
          ? t.merchant.name.toLowerCase()
          : ''
        return (
          t.description.toLowerCase().includes(q) ||
          merchantName.includes(q) ||
          t.notes.toLowerCase().includes(q)
        )
      })
    }

    const offset = opts.offset ?? 0
    const limit = opts.limit ?? 100

    return txns.slice(offset, offset + limit)
  }

  getTransaction(id: string): MonzoTransaction | undefined {
    return this.cache.transactions.find((t) => t.id === id)
  }

  updateTransaction(tx: MonzoTransaction): void {
    const idx = this.cache.transactions.findIndex((t) => t.id === tx.id)
    if (idx >= 0) {
      this.cache.transactions[idx] = tx
      this.save()
    }
  }

  pushTransaction(tx: MonzoTransaction): void {
    // From webhook — add if not already present
    const existing = this.cache.transactions.findIndex((t) => t.id === tx.id)
    if (existing >= 0) {
      this.cache.transactions[existing] = tx
    } else {
      this.cache.transactions.unshift(tx)
    }
    this.save()
  }

  // --------------------------------------------------------------------------
  // Spending breakdown
  // --------------------------------------------------------------------------

  getSpending(opts: { month?: string } = {}): Record<string, number> {
    // Default to current month
    const now = new Date()
    const month = opts.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const [year, mon] = month.split('-').map(Number)
    const start = new Date(year!, mon! - 1, 1)
    const end = new Date(year!, mon!, 1)

    const spending: Record<string, number> = {}

    for (const tx of this.cache.transactions) {
      const created = new Date(tx.created)
      if (created < start || created >= end) continue
      if (tx.amount >= 0) continue // Skip income/top-ups
      if (tx.decline_reason) continue // Skip declined

      const category = tx.category || 'general'
      spending[category] = (spending[category] ?? 0) + Math.abs(tx.amount)
    }

    return spending
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private save(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      writeFileSync(this.cachePath, JSON.stringify(this.cache), 'utf8')
    } catch (err) {
      console.error('[monzo] Failed to save cache:', (err as Error).message)
    }
  }

  private load(): MonzoCache {
    try {
      const data = readFileSync(this.cachePath, 'utf8')
      const cache = JSON.parse(data) as MonzoCache
      console.log(`[monzo] Loaded ${cache.transactions.length} cached transactions`)
      return cache
    } catch {
      return { ...EMPTY_CACHE }
    }
  }

  clear(): void {
    this.cache = { ...EMPTY_CACHE }
    this.save()
  }
}
