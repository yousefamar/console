// Money pane renderer.
//
// Status row: balance + spend-today.
// Body: selected transaction details, or 4 most recent transactions.

import { useMoneyStore, formatAmount, getDisplayName } from '@/store/money'
import { buildStatus, clipRow, type MirrorFrame, BODY_ROWS } from '../mirror'

function fmtDay(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${String(d.getDate()).padStart(2, '0')} ${d.toLocaleString('en', { month: 'short' })}`
}

export function renderMoney(): MirrorFrame | null {
  const { balance, transactions, selectedTransactionId } = useMoneyStore.getState()

  const balanceLabel = balance ? `£${(balance.balance / 100).toFixed(2)}` : null
  const spendLabel = balance ? `today ${formatAmount(-balance.spend_today)}` : null

  if (selectedTransactionId) {
    const tx = transactions.find((t) => t.id === selectedTransactionId)
    if (tx) {
      const body = [
        clipRow(getDisplayName(tx)),
        clipRow(formatAmount(tx.amount)),
        clipRow(tx.category || ''),
        clipRow(tx.notes || fmtDay(tx.created)),
      ].slice(0, BODY_ROWS)
      return {
        status: buildStatus(['Money', 'tx']),
        body,
      }
    }
  }

  const recent = transactions.slice(0, BODY_ROWS)
  const body = recent.map((tx) => clipRow(`${formatAmount(tx.amount).padStart(9, ' ')} ${getDisplayName(tx)}`))

  return {
    status: buildStatus(['Money', balanceLabel, spendLabel]),
    body,
  }
}
