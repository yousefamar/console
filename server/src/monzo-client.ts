// Monzo REST API client — server-side
// Uses auth-store for token management

import type { AuthStore } from './auth-store.js'

const MONZO_BASE = 'https://api.monzo.com'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface MonzoAccount {
  id: string
  description: string
  created: string
  type?: string
}

export interface MonzoBalance {
  balance: number          // available balance in minor units (pennies)
  total_balance: number    // balance + all pots
  currency: string         // ISO 4217 (e.g. "GBP")
  spend_today: number      // amount spent today (from ~4am)
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

export interface MonzoTransaction {
  id: string
  amount: number           // minor units, negative = spend
  currency: string
  created: string          // ISO 8601
  settled: string          // empty string if pending
  description: string
  merchant: MonzoMerchant | string | null
  notes: string
  metadata: Record<string, string>
  category: string
  is_load: boolean
  decline_reason?: string
  account_id: string
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

export interface MonzoWebhook {
  id: string
  account_id: string
  url: string
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

export class MonzoClient {
  constructor(private authStore: AuthStore) {}

  private async request<T>(
    path: string,
    opts: {
      method?: string
      params?: Record<string, string | undefined>
      formBody?: Record<string, string>
    } = {},
  ): Promise<T> {
    const token = await this.authStore.getMonzoToken()
    if (!token) {
      throw new MonzoApiError(401, 'Monzo not authenticated')
    }

    const url = new URL(`${MONZO_BASE}${path}`)
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    }
    let body: string | undefined
    if (opts.formBody) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(opts.formBody).toString()
    }

    let res = await fetch(url.toString(), { method: opts.method ?? 'GET', headers, body })

    // Auto-refresh on 401
    if (res.status === 401) {
      const refreshed = await this.authStore.refreshMonzoToken()
      if (refreshed) {
        const newToken = await this.authStore.getMonzoToken()
        if (newToken) {
          headers.Authorization = `Bearer ${newToken}`
          res = await fetch(url.toString(), { method: opts.method ?? 'GET', headers, body })
        }
      }
    }

    if (!res.ok) {
      const text = await res.text()
      throw new MonzoApiError(res.status, `Monzo API ${res.status}: ${text}`)
    }

    const text = await res.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
  }

  // -------------------------------------------------------------------------
  // Auth check
  // -------------------------------------------------------------------------

  async whoAmI(): Promise<{ authenticated: boolean; client_id: string; user_id: string }> {
    return this.request('/ping/whoami')
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  async getAccounts(accountType?: string): Promise<MonzoAccount[]> {
    const params: Record<string, string | undefined> = {}
    if (accountType) params.account_type = accountType
    const data = await this.request<{ accounts: MonzoAccount[] }>('/accounts', { params })
    return data.accounts
  }

  // -------------------------------------------------------------------------
  // Balance
  // -------------------------------------------------------------------------

  async getBalance(accountId: string): Promise<MonzoBalance> {
    return this.request('/balance', { params: { account_id: accountId } })
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  async listTransactions(
    accountId: string,
    opts?: { since?: string; before?: string; limit?: number; expand?: string[] },
  ): Promise<MonzoTransaction[]> {
    const params: Record<string, string | undefined> = {
      account_id: accountId,
      since: opts?.since,
      before: opts?.before,
      limit: opts?.limit?.toString(),
    }
    // expand[] needs special handling
    const url = new URL(`${MONZO_BASE}/transactions`)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v)
    }
    if (opts?.expand) {
      for (const e of opts.expand) {
        url.searchParams.append('expand[]', e)
      }
    }

    const token = await this.authStore.getMonzoToken()
    if (!token) throw new MonzoApiError(401, 'Monzo not authenticated')

    let res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (res.status === 401) {
      const refreshed = await this.authStore.refreshMonzoToken()
      if (refreshed) {
        const newToken = await this.authStore.getMonzoToken()
        if (newToken) {
          res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${newToken}` },
          })
        }
      }
    }

    if (!res.ok) {
      const text = await res.text()
      throw new MonzoApiError(res.status, `Monzo API ${res.status}: ${text}`)
    }

    const data = await res.json() as { transactions: MonzoTransaction[] }
    return data.transactions
  }

  async getTransaction(txId: string, expand?: string[]): Promise<MonzoTransaction> {
    const url = new URL(`${MONZO_BASE}/transactions/${txId}`)
    if (expand) {
      for (const e of expand) {
        url.searchParams.append('expand[]', e)
      }
    }

    const token = await this.authStore.getMonzoToken()
    if (!token) throw new MonzoApiError(401, 'Monzo not authenticated')

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new MonzoApiError(res.status, `Monzo API ${res.status}: ${text}`)
    }

    const data = await res.json() as { transaction: MonzoTransaction }
    return data.transaction
  }

  async annotateTransaction(txId: string, metadata: Record<string, string>): Promise<MonzoTransaction> {
    const formBody: Record<string, string> = {}
    for (const [k, v] of Object.entries(metadata)) {
      formBody[`metadata[${k}]`] = v
    }
    const data = await this.request<{ transaction: MonzoTransaction }>(`/transactions/${txId}`, {
      method: 'PATCH',
      formBody,
    })
    return data.transaction
  }

  // -------------------------------------------------------------------------
  // Pots
  // -------------------------------------------------------------------------

  async getPots(accountId: string): Promise<MonzoPot[]> {
    const data = await this.request<{ pots: MonzoPot[] }>('/pots', {
      params: { current_account_id: accountId },
    })
    return data.pots
  }

  async depositToPot(potId: string, accountId: string, amount: number, dedupeId: string): Promise<MonzoPot> {
    return this.request(`/pots/${potId}/deposit`, {
      method: 'PUT',
      formBody: {
        source_account_id: accountId,
        amount: amount.toString(),
        dedupe_id: dedupeId,
      },
    })
  }

  async withdrawFromPot(potId: string, accountId: string, amount: number, dedupeId: string): Promise<MonzoPot> {
    return this.request(`/pots/${potId}/withdraw`, {
      method: 'PUT',
      formBody: {
        destination_account_id: accountId,
        amount: amount.toString(),
        dedupe_id: dedupeId,
      },
    })
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  async registerWebhook(accountId: string, url: string): Promise<{ webhook: MonzoWebhook }> {
    return this.request('/webhooks', {
      method: 'POST',
      formBody: { account_id: accountId, url },
    })
  }

  async listWebhooks(accountId: string): Promise<MonzoWebhook[]> {
    const data = await this.request<{ webhooks: MonzoWebhook[] }>('/webhooks', {
      params: { account_id: accountId },
    })
    return data.webhooks
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request(`/webhooks/${webhookId}`, { method: 'DELETE' })
  }
}

// --------------------------------------------------------------------------
// Error
// --------------------------------------------------------------------------

export class MonzoApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'MonzoApiError'
  }
}
