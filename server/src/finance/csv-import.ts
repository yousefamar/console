// Monzo CSV export → MonzoTransaction merge.
//
// The Monzo data export includes 8+ years of history — far more than the API's
// 90-day cap. Importing it once enriches the cache permanently. The CSV
// columns are:
//
//   Transaction ID, Date (DD/MM/YYYY), Time (HH:MM:SS), Type, Name, Emoji,
//   Category, Amount (£), Currency, Local amount, Local currency,
//   Notes and #tags, Address, Receipt, Description, Category split,
//   Money Out, Money In
//
// This module is pure: it parses the CSV into MonzoTransaction-shape rows
// (with synthesised fields where the API provides more than the CSV) ready
// to push into MonzoStore.

import type { MonzoTransaction } from '../monzo-client.js'

export interface ImportedTx extends MonzoTransaction {}

export interface ImportSummary {
  total: number
  imported: number
  skipped: number
  earliestDate: string | null
  latestDate: string | null
  errors: Array<{ line: number; reason: string }>
}

// --------------------------------------------------------------------------
// CSV parser (handles quoted fields with commas / newlines inside)
// --------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  while (i < text.length) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') {
      row.push(field); rows.push(row)
      row = []; field = ''; i++; continue
    }
    field += c; i++
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

// --------------------------------------------------------------------------
// CSV row → MonzoTransaction
// --------------------------------------------------------------------------

const MONZO_CATEGORY_NORMALISE: Record<string, string> = {
  'general': 'general',
  'eating out': 'eating_out',
  'transport': 'transport',
  'cash': 'cash',
  'bills': 'bills',
  'entertainment': 'entertainment',
  'shopping': 'shopping',
  'holidays': 'holidays',
  'groceries': 'groceries',
  'expenses': 'expenses',
  'family': 'family',
  'finances': 'finances',
  'savings': 'savings',
  'income': 'income',
  'transfers': 'transfers',
  'gifts': 'gifts',
  'charity': 'charity',
  'personal care': 'personal_care',
}

const TYPE_TO_SCHEME: Record<string, string> = {
  'Card payment': 'mastercard',
  'Faster payment': 'payport_faster_payments',
  'Bacs (Direct Credit)': 'bacs',
  'Direct Debit': 'bacs',
  'Bank transfer': 'payport_faster_payments',
  'Monzo-to-Monzo': 'monzo_to_monzo',
  'Pot transfer': 'pot_transfer',
  'Monzo.me / Top-up': 'monzo_top_up',
  'monzo_paid': 'monzo_paid',
  'ledger_adjustment': 'ledger_adjustment',
  'chaps': 'chaps',
  'international-payments': 'international',
}

function parseDate(date: string, time: string): string {
  // DD/MM/YYYY HH:MM:SS  →  YYYY-MM-DDTHH:MM:SS+00:00
  const [d, m, y] = date.split('/')
  const t = time && time.length > 0 ? time : '00:00:00'
  return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}T${t}+00:00`
}

function parsePounds(s: string): number {
  if (!s) return 0
  // Strip non-numeric except sign and dot, then × 100 → pence
  const n = parseFloat(s.replace(/[^\d.\-]/g, ''))
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

export function rowToTransaction(
  cols: string[],
  accountId: string,
): MonzoTransaction | null {
  const id = cols[0]
  const date = cols[1]
  const time = cols[2]
  const type = cols[3] ?? ''
  const name = cols[4] ?? ''
  const emoji = cols[5] ?? ''
  const category = cols[6] ?? ''
  const amount = cols[7] ?? ''
  const currency = cols[8] || 'GBP'
  const localAmount = cols[9] ?? ''
  const localCurrency = cols[10] ?? ''
  const notes = cols[11] ?? ''
  const _address = cols[12] ?? ''
  const _receipt = cols[13] ?? ''
  const description = cols[14] ?? ''

  if (!id || !id.startsWith('tx_')) return null

  const created = parseDate(date!, time!)
  const amountPence = parsePounds(amount)
  const localPence = parsePounds(localAmount)

  const isPotTransfer = type === 'Pot transfer'
  const isMonzoToMonzo = type === 'Monzo-to-Monzo'
  const isCardPayment = type === 'Card payment'

  // Synthesize merchant for card payments. The CSV's "Name" is the merchant
  // name; "Description" usually has the raw card-network text.
  const merchant = isCardPayment && name
    ? {
        id: `csv_${name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40)}`,
        group_id: '',
        name,
        logo: '',
        emoji: emoji || '',
        category: (MONZO_CATEGORY_NORMALISE[category.toLowerCase()] ?? 'general'),
      }
    : null

  // Counterparty for bank transfers / Monzo-to-Monzo.
  const counterparty = (!isCardPayment && !isPotTransfer && name) ? { name } : undefined

  const tx: MonzoTransaction = {
    id,
    amount: amountPence,
    currency,
    created,
    settled: created, // CSV doesn't distinguish; assume settled
    description: description || name || '',
    merchant: merchant as MonzoTransaction['merchant'],
    notes: notes || '',
    metadata: {},
    category: (MONZO_CATEGORY_NORMALISE[category.toLowerCase()] ?? 'general'),
    is_load: false,
    account_id: accountId,
    ...(counterparty ? { counterparty } : {}),
    ...(TYPE_TO_SCHEME[type] ? { scheme: TYPE_TO_SCHEME[type] } : {}),
    ...(localCurrency && localCurrency !== currency
      ? { local_amount: localPence, local_currency: localCurrency }
      : {}),
    // Tag pot transfers in metadata so they can be ignored / classified later
    ...(isPotTransfer ? { metadata: { source: 'pot_transfer', pot_name: name } } : {}),
    ...(isMonzoToMonzo ? { metadata: { source: 'monzo_to_monzo' } } : {}),
  } as MonzoTransaction
  return tx
}

export function importCsv(
  csvText: string,
  accountId: string,
): { txs: MonzoTransaction[]; summary: ImportSummary } {
  const rows = parseCsv(csvText)
  const summary: ImportSummary = {
    total: 0, imported: 0, skipped: 0,
    earliestDate: null, latestDate: null, errors: [],
  }
  if (rows.length === 0) return { txs: [], summary }
  const header = rows[0]!.map((h) => h.trim())
  // Sanity: column 0 must be Transaction ID
  if (!header[0] || !header[0].toLowerCase().includes('transaction id')) {
    summary.errors.push({ line: 0, reason: `Unexpected header: ${header.join(',')}` })
    return { txs: [], summary }
  }
  const txs: MonzoTransaction[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue
    summary.total++
    try {
      const tx = rowToTransaction(row, accountId)
      if (!tx) { summary.skipped++; continue }
      txs.push(tx)
      summary.imported++
      const d = tx.created.slice(0, 10)
      if (!summary.earliestDate || d < summary.earliestDate) summary.earliestDate = d
      if (!summary.latestDate || d > summary.latestDate) summary.latestDate = d
    } catch (err) {
      summary.errors.push({ line: i + 1, reason: (err as Error).message })
      summary.skipped++
    }
  }
  return { txs, summary }
}
