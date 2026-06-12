// Monzo routes — transaction browsing, pot management, spending

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MonzoClient } from '../monzo-client.js'
import type { MonzoStore } from '../monzo-store.js'
import type { AuthStore } from '../auth-store.js'
import type { HubMessage } from '../protocol.js'
import type { PushServer } from '../push.js'

export function handleMonzoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  monzoClient: MonzoClient,
  monzoStore: MonzoStore,
  authStore: AuthStore,
  readBody: (req: IncomingMessage) => Promise<string>,
  broadcast: (msg: HubMessage) => void,
  pushServer: PushServer,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const error = (status: number, msg: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: msg }))
  }

  // Helper to get account ID (cached or fetch)
  const getAccountId = async (): Promise<string | null> => {
    const monzo = authStore.getMonzoConfig()
    if (monzo?.accountId) return monzo.accountId

    try {
      const accounts = await monzoClient.getAccounts('uk_retail')
      if (accounts.length > 0) {
        authStore.setMonzoAccountId(accounts[0]!.id)
        return accounts[0]!.id
      }
    } catch {}
    return null
  }

  // GET /money/status
  if (path === '/money/status' && req.method === 'GET') {
    const monzo = authStore.getMonzoConfig()
    json({
      connected: !!monzo?.accessToken,
      hasCredentials: !!(monzo?.clientId && monzo?.clientSecret),
      accountId: monzo?.accountId ?? null,
      lastSync: monzoStore.lastSync,
      transactionCount: monzoStore.transactionCount,
      fullSyncComplete: monzoStore.isFullSyncComplete,
    })
    return true
  }

  // GET /money/accounts
  if (path === '/money/accounts' && req.method === 'GET') {
    monzoClient.getAccounts().then((accounts) => {
      json(accounts)
    }).catch((err) => {
      error(err.status ?? 500, (err as Error).message)
    })
    return true
  }

  // GET /money/balance
  if (path === '/money/balance' && req.method === 'GET') {
    getAccountId().then(async (accountId) => {
      if (!accountId) return error(400, 'No account found')
      const balance = await monzoClient.getBalance(accountId)
      json(balance)
    }).catch((err) => {
      error(err.status ?? 500, (err as Error).message)
    })
    return true
  }

  // GET /money/transactions
  if (path === '/money/transactions' && req.method === 'GET') {
    const since = url.searchParams.get('since') ?? undefined
    const before = url.searchParams.get('before') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const search = url.searchParams.get('search') ?? undefined
    const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!) : undefined
    const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!) : undefined

    const transactions = monzoStore.getTransactions({ since, before, category, search, limit, offset })
    json(transactions)
    return true
  }

  // GET /money/transactions/:id
  const txMatch = path.match(/^\/money\/transactions\/([^/]+)$/)
  if (txMatch && req.method === 'GET') {
    const tx = monzoStore.getTransaction(txMatch[1]!)
    if (tx) {
      json(tx)
    } else {
      error(404, 'Transaction not found')
    }
    return true
  }

  // PATCH /money/transactions/:id
  if (txMatch && req.method === 'PATCH') {
    readBody(req).then(async (body) => {
      const { metadata } = JSON.parse(body) as { metadata: Record<string, string> }
      const updated = await monzoClient.annotateTransaction(txMatch[1]!, metadata)
      monzoStore.updateTransaction(updated)
      json(updated)
    }).catch((err) => {
      error(err.status ?? 500, (err as Error).message)
    })
    return true
  }

  // GET /money/pots
  if (path === '/money/pots' && req.method === 'GET') {
    getAccountId().then(async (accountId) => {
      if (!accountId) return error(400, 'No account found')
      const pots = await monzoClient.getPots(accountId)
      // Filter out deleted pots
      json(pots.filter((p) => !p.deleted))
    }).catch((err) => {
      error(err.status ?? 500, (err as Error).message)
    })
    return true
  }

  // POST /money/pots/:id/deposit
  const potDepositMatch = path.match(/^\/money\/pots\/([^/]+)\/deposit$/)
  if (potDepositMatch && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { amount } = JSON.parse(body) as { amount: number }
      const accountId = await getAccountId()
      if (!accountId) return error(400, 'No account found')
      const dedupeId = randomUUID()
      const pot = await monzoClient.depositToPot(potDepositMatch[1]!, accountId, amount, dedupeId)
      json(pot)
    }).catch((err) => {
      error(err.status ?? 500, (err as Error).message)
    })
    return true
  }

  // POST /money/pots/:id/withdraw
  const potWithdrawMatch = path.match(/^\/money\/pots\/([^/]+)\/withdraw$/)
  if (potWithdrawMatch && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { amount } = JSON.parse(body) as { amount: number }
      const accountId = await getAccountId()
      if (!accountId) return error(400, 'No account found')
      const dedupeId = randomUUID()
      const pot = await monzoClient.withdrawFromPot(potWithdrawMatch[1]!, accountId, amount, dedupeId)
      json(pot)
    }).catch((err) => {
      error(err.status ?? 500, (err as Error).message)
    })
    return true
  }

  // POST /money/sync
  if (path === '/money/sync' && req.method === 'POST') {
    getAccountId().then(async (accountId) => {
      if (!accountId) return error(400, 'No account found')

      if (!monzoStore.isFullSyncComplete) {
        // First sync — full history
        await monzoStore.fullSync(accountId)
        json({ synced: monzoStore.transactionCount, type: 'full' })
      } else {
        // Incremental
        const newTxns = await monzoStore.incrementalSync(accountId)
        json({ synced: newTxns.length, type: 'incremental', total: monzoStore.transactionCount })
      }
    }).catch((err) => {
      error(err.status ?? 500, (err as Error).message)
    })
    return true
  }

  // GET /money/spending
  if (path === '/money/spending' && req.method === 'GET') {
    const month = url.searchParams.get('month') ?? undefined
    const spending = monzoStore.getSpending({ month })
    json(spending)
    return true
  }

  // GET /money/webhook-url — returns the public webhook URL with secret
  if (path === '/money/webhook-url' && req.method === 'GET') {
    const secret = authStore.getWebhookSecret()
    // Monzo POSTs through con.amar.io's Caddy → /hub/money/webhook → (strip)
    // /money/webhook, which is always-open in the auth middleware; the secret
    // in the query string is the actual auth. The old hub.amar.io vhost is
    // dead (DNS never got a dynamic A record after the WAN IP changed).
    const origin = process.env.CONSOLE_PUBLIC_ORIGIN || 'https://con.amar.io'
    json({ url: `${origin}/hub/money/webhook?secret=${secret}` })
    return true
  }

  // POST /money/webhook/register — sync Monzo's registered webhook to the
  // canonical URL: deletes any webhook pointing elsewhere, registers the
  // current one if missing. Idempotent. Returns the final webhook list.
  if (path === '/money/webhook/register' && req.method === 'POST') {
    const accountId = authStore.getMonzoConfig()?.accountId
    if (!accountId) {
      error(400, 'Monzo account not configured')
      return true
    }
    const secret = authStore.getWebhookSecret()
    const origin = process.env.CONSOLE_PUBLIC_ORIGIN || 'https://con.amar.io'
    const canonical = `${origin}/hub/money/webhook?secret=${secret}`
    ;(async () => {
      const existing = await monzoClient.listWebhooks(accountId)
      const stale = existing.filter((w) => w.url !== canonical)
      for (const w of stale) {
        await monzoClient.deleteWebhook(w.id)
      }
      const hasCanonical = existing.some((w) => w.url === canonical)
      if (!hasCanonical) {
        await monzoClient.registerWebhook(accountId, canonical)
      }
      const final = await monzoClient.listWebhooks(accountId)
      json({ ok: true, deleted: stale.length, registered: !hasCanonical, webhooks: final.map((w) => ({ id: w.id, url: w.url.replace(secret, '<secret>') })) })
    })().catch((err: Error) => error(500, err.message))
    return true
  }

  // POST /money/webhook — receive Monzo webhook (public endpoint, secret-protected)
  if (path === '/money/webhook' && req.method === 'POST') {
    // Verify webhook secret
    const secret = url.searchParams.get('secret')
    if (secret !== authStore.getWebhookSecret()) {
      error(403, 'Invalid webhook secret')
      return true
    }

    readBody(req).then((body) => {
      const payload = JSON.parse(body) as { type: string; data: any }
      if (payload.type === 'transaction.created') {
        monzoStore.pushTransaction(payload.data)
        // Broadcast to connected browser clients
        broadcast({
          type: 'monzo_transaction',
          transaction: payload.data,
        } as any)
        // Push a notification to the APK foreground service
        const tx = payload.data
        const amountPence = typeof tx.amount === 'number' ? tx.amount : 0
        const currency = tx.currency || 'GBP'
        const merchant = tx.merchant?.name || tx.description || 'Transaction'
        const sign = amountPence < 0 ? '-' : '+'
        const formatted = `${sign}${currency === 'GBP' ? '£' : ''}${(Math.abs(amountPence) / 100).toFixed(2)}`
        pushServer.broadcast({
          type: 'money',
          title: merchant,
          body: formatted,
          pane: 'money',
          id: `monzo:${tx.id}`,
        })
        console.log(`[monzo] Webhook: new transaction ${payload.data.id}`)
      }
      json({ ok: true })
    }).catch((err) => {
      error(400, (err as Error).message)
    })
    return true
  }

  return false
}
