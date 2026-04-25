// Heuristic detection of "where did the money go" — scans Monzo transactions
// for outbound flows that look like deposits to external accounts, so we can
// propose manual-account ledger entries.
//
// Detection rules are deliberately conservative; user confirms via UI/CLI.

import type { MonzoTransaction } from '../monzo-client.js'

export interface AccountCandidate {
  /** Stable id for this proposed grouping (e.g. "monzo-isa-seccl"). */
  key: string
  /** Display name we'd put on the suggested account. */
  suggestedName: string
  /** 'liquid' | 'investment' | 'illiquid'. */
  suggestedLiquidity: 'liquid' | 'investment' | 'illiquid'
  /** Whether this is held by someone else on the user's behalf. */
  isExternal: boolean
  /** Counterparty / merchant pattern that triggered the rule. */
  matchedBy: string
  /** Sum of outbound (you → them) pence. Inbound (them → you) shown separately. */
  totalOutPence: number
  totalInPence: number
  /** Net flow = out - in (i.e. estimated balance held there if it started at 0). */
  netPence: number
  count: number
  firstDate: string
  lastDate: string
  /** Sample transactions, newest first, capped to 20. */
  samples: Array<{ id: string; date: string; amountPence: number; description: string; notes: string }>
  /** Suggested ledger entries to create — one per "deposit moment". */
  suggestedLedger: Array<{ date: string; balancePence: number; note: string }>
}

interface RuleHit {
  key: string
  suggestedName: string
  suggestedLiquidity: 'liquid' | 'investment' | 'illiquid'
  isExternal: boolean
  matchedBy: string
  /** Sign convention: outflow contributes positive to "deposited"; inflow negative. */
}

/**
 * Match a transaction against known external-account patterns.
 * Returns null if nothing matches — the transaction is presumed regular spend.
 */
function classifyForAccount(tx: MonzoTransaction): RuleHit | null {
  const merchantName = typeof tx.merchant === 'object' && tx.merchant ? tx.merchant.name : ''
  const counterparty = (tx as unknown as { counterparty?: { name?: string } }).counterparty?.name ?? ''
  const description = tx.description ?? ''
  const notes = tx.notes ?? ''
  const haystack = `${merchantName}\n${counterparty}\n${description}\n${notes}`.toLowerCase()

  // Monzo S&S ISA — uses Seccl as the platform
  if (haystack.includes('seccl')) {
    return { key: 'monzo-isa-seccl', suggestedName: 'Monzo S&S ISA', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'Seccl' }
  }
  // Veronica's S&S ISA — only large transfers labelled with "isa" or "invest"
  if (counterparty.toLowerCase().includes('veronica') || merchantName.toLowerCase().includes('veronica')) {
    const looksLikeInvestment = /\b(isa|invest|s&s|stonk|stocks)\b/i.test(`${notes} ${description}`)
    if (looksLikeInvestment && Math.abs(tx.amount) >= 50_000) {
      return { key: 'veronica-isa', suggestedName: "Veronica's S&S ISA (held externally)", suggestedLiquidity: 'investment', isExternal: true, matchedBy: 'Veronica + ISA keyword' }
    }
    return null
  }
  // Common UK brokers
  if (/\bfreetrade\b/.test(haystack)) {
    return { key: 'freetrade', suggestedName: 'Freetrade GIA', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'Freetrade' }
  }
  if (/\btrading\s*212\b|\bt212\b/.test(haystack)) {
    return { key: 'trading212', suggestedName: 'Trading 212', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'Trading 212' }
  }
  if (/\bhargreaves\b|\bh\s*l\s*plc\b/.test(haystack)) {
    return { key: 'hargreaves-lansdown', suggestedName: 'Hargreaves Lansdown', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'Hargreaves Lansdown' }
  }
  if (/\bvanguard\b/.test(haystack)) {
    return { key: 'vanguard', suggestedName: 'Vanguard', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'Vanguard' }
  }
  if (/\binteractive\s*brokers?\b|\bibkr\b/.test(haystack)) {
    return { key: 'ibkr', suggestedName: 'Interactive Brokers', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'Interactive Brokers' }
  }
  if (/\binvestengine\b/.test(haystack)) {
    return { key: 'investengine', suggestedName: 'InvestEngine', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'InvestEngine' }
  }
  // Other banks the user mentioned
  if (/\blloyds\b/.test(haystack)) {
    return { key: 'lloyds', suggestedName: 'Lloyds', suggestedLiquidity: 'liquid', isExternal: false, matchedBy: 'Lloyds' }
  }
  if (/\brevolut\b/.test(haystack)) {
    return { key: 'revolut', suggestedName: 'Revolut', suggestedLiquidity: 'liquid', isExternal: false, matchedBy: 'Revolut' }
  }
  // Crypto on/off-ramps
  if (/\bcoinbase\b|\bkraken\b|\bbinance\b|\bbitstamp\b|\bgemini\b/.test(haystack)) {
    return { key: 'crypto', suggestedName: 'Crypto exchange', suggestedLiquidity: 'investment', isExternal: false, matchedBy: 'Crypto exchange' }
  }
  return null
}

export function detectAccountCandidates(txns: MonzoTransaction[]): AccountCandidate[] {
  // Group by rule key
  const groups = new Map<string, { rule: RuleHit; txs: MonzoTransaction[] }>()
  for (const tx of txns) {
    if (tx.decline_reason) continue
    const hit = classifyForAccount(tx)
    if (!hit) continue
    const g = groups.get(hit.key) ?? { rule: hit, txs: [] }
    g.txs.push(tx)
    groups.set(hit.key, g)
  }

  const out: AccountCandidate[] = []
  for (const [key, { rule, txs }] of groups) {
    txs.sort((a, b) => a.created.localeCompare(b.created))
    let totalOut = 0, totalIn = 0
    const suggestedLedger: AccountCandidate['suggestedLedger'] = []
    let runningBalance = 0
    for (const tx of txs) {
      // Convention: tx.amount is signed (negative = money leaving Monzo).
      // For deposit-like rules: tx.amount<0 → money was deposited into the
      // external account → balance there grows by |amount|.
      const deposited = -tx.amount
      runningBalance += deposited
      if (tx.amount < 0) totalOut += -tx.amount
      else totalIn += tx.amount
      // Each "moment" → a balance entry at that date. Cap to large/significant
      // events (≥£500) to avoid hundreds of micro-rows for chatty patterns.
      if (Math.abs(tx.amount) >= 50_000) {
        suggestedLedger.push({
          date: tx.created.slice(0, 10),
          balancePence: runningBalance,
          note: tx.notes || tx.description || `${tx.amount < 0 ? 'Deposit' : 'Withdrawal'}: ${rule.suggestedName}`,
        })
      }
    }
    out.push({
      key,
      suggestedName: rule.suggestedName,
      suggestedLiquidity: rule.suggestedLiquidity,
      isExternal: rule.isExternal,
      matchedBy: rule.matchedBy,
      totalOutPence: totalOut,
      totalInPence: totalIn,
      netPence: totalOut - totalIn,
      count: txs.length,
      firstDate: txs[0]!.created.slice(0, 10),
      lastDate: txs[txs.length - 1]!.created.slice(0, 10),
      samples: txs.slice(-20).reverse().map((t) => ({
        id: t.id,
        date: t.created.slice(0, 10),
        amountPence: t.amount,
        description: t.description,
        notes: t.notes,
      })),
      suggestedLedger,
    })
  }
  out.sort((a, b) => Math.abs(b.netPence) - Math.abs(a.netPence))
  return out
}
