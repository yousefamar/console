// SharedTabPanel — outstanding shared-tab balance per counterparty. The user
// pays for shared expenses in full; the counterparty owes them back per the
// rule's sharedFraction. Inbound transfers from that counterparty count as
// reimbursements. Net balance = what's still owed (positive) or what the
// user owes (negative).

import { useState } from 'react'
import { ChevronRight, ChevronDown, Users } from 'lucide-react'
import { useFinanceStore, fmtPence } from '@/store/finance'

export function SharedTabPanel() {
  const balances = useFinanceStore((s) => s.sharedTabBalances)
  const [openCounterparty, setOpenCounterparty] = useState<string | null>(null)

  if (balances.length === 0) {
    return (
      <div className="border-b border-border py-3 px-4">
        <div className="flex items-center gap-2 mb-2">
          <Users size={12} className="text-text-tertiary" />
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Shared tabs</h3>
        </div>
        <p className="text-[11px] text-text-tertiary">
          No shared-tab activity yet. Set <code className="text-text-secondary">sharedFraction</code> on
          a rule (e.g. Sainsbury's split 50/50 with Veronica) — your shared spend will appear here, with
          her inbound reimbursements netted off.
        </p>
      </div>
    )
  }

  return (
    <div className="border-b border-border py-3">
      <div className="px-4 flex items-center gap-2 mb-2">
        <Users size={12} className="text-text-tertiary" />
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Shared tabs</h3>
      </div>
      <div className="px-4 space-y-2">
        {balances.map((b) => {
          const isOpen = openCounterparty === b.counterparty
          const net = b.netOwedToYouPence
          const pos = net > 0
          return (
            <div key={b.counterparty} className="border border-border rounded-sm">
              <button onClick={() => setOpenCounterparty(isOpen ? null : b.counterparty)}
                className="w-full text-left flex items-center gap-2 px-3 py-2">
                {isOpen ? <ChevronDown size={12} className="text-text-tertiary" /> : <ChevronRight size={12} className="text-text-tertiary" />}
                <span className="text-sm text-text-primary truncate flex-1">{b.counterparty}</span>
                <span className={`text-xs tabular-nums ${pos ? 'text-green-400' : net < 0 ? 'text-red-400' : 'text-text-tertiary'}`}>
                  {pos ? `owes you ${fmtPence(net, { abs: true })}`
                    : net < 0 ? `you owe ${fmtPence(net, { abs: true })}`
                    : 'settled'}
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-border bg-surface-1 p-3 space-y-2 text-xs">
                  <div className="grid grid-cols-3 gap-3">
                    <Tile label="Their share (you covered)" value={fmtPence(b.theyOwePence, { abs: true })} />
                    <Tile label="Their reimbursements to you" value={fmtPence(b.theyPaidPence, { abs: true })} />
                    <Tile label="Net" value={fmtPence(net, { abs: true })}
                      colour={pos ? 'text-green-400' : net < 0 ? 'text-red-400' : 'text-text-tertiary'} />
                  </div>
                  <div className="text-[10px] text-text-tertiary">
                    Activity {b.oldestSharedDate ?? '—'} → {b.latestSharedDate ?? '—'}
                  </div>

                  {b.sampleShared.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-text-secondary cursor-pointer">Recent shared expenses ({b.sampleShared.length})</summary>
                      <div className="mt-1 space-y-0.5">
                        {b.sampleShared.map((s) => (
                          <div key={s.id} className="flex items-center gap-2">
                            <span className="text-text-tertiary w-20 tabular-nums">{s.date}</span>
                            <span className="flex-1 truncate text-text-secondary">{s.merchant}</span>
                            <span className="text-text-tertiary tabular-nums">gross {fmtPence(s.grossPence, { abs: true })}</span>
                            <span className="text-green-400 tabular-nums">+{fmtPence(s.theirSharePence, { abs: true })}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {b.sampleReimbursements.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-text-secondary cursor-pointer">Recent reimbursements from them ({b.sampleReimbursements.length})</summary>
                      <div className="mt-1 space-y-0.5">
                        {b.sampleReimbursements.map((r) => (
                          <div key={r.id} className="flex items-center gap-2">
                            <span className="text-text-tertiary w-20 tabular-nums">{r.date}</span>
                            <span className="flex-1 truncate text-text-secondary">{r.note || '—'}</span>
                            <span className="text-red-400 tabular-nums">-{fmtPence(r.amountPence, { abs: true })}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Tile({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`tabular-nums ${colour ?? 'text-text-primary'}`}>{value}</div>
    </div>
  )
}
