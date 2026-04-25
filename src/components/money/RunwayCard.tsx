// RunwayCard — headline for the Cashflow view. Shows liquid + investment +
// emergency floor + monthly burn + months-to-floor in a single dense block.

import { ArrowDown, ArrowUp, AlertTriangle } from 'lucide-react'
import { useFinanceStore, fmtPence } from '@/store/finance'

export function RunwayCard() {
  const runway = useFinanceStore((s) => s.runway)
  const settings = useFinanceStore((s) => s.settings)

  if (!runway) {
    return (
      <div className="px-4 py-6 text-xs text-text-tertiary">No runway data yet — add at least one account in Net Worth.</div>
    )
  }

  const burn = runway.monthlyBurnPence
  const isBurning = burn < 0
  // monthsToFloor is Infinity when projection never breaches the floor; JSON
  // serialises that to null. Treat null as ∞ here.
  const months = runway.monthsToFloor
  const neverHitsFloor = months == null || !Number.isFinite(months)
  const monthsLabel = neverHitsFloor ? '∞' : Math.floor(months as number).toString()
  const floorDate = runway.floorDate
  const dateLabel = floorDate
    ? new Date(floorDate + '-01').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
    : neverHitsFloor ? 'never (positive cashflow)' : '—'

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 p-4">
      <Metric label="Liquid" value={fmtPence(runway.liquidPence, { abs: true })} hint="Cash + bank + Monzo" />
      <Metric label="Investments" value={fmtPence(runway.investmentPence, { abs: true })} hint="ISA + GIA + held-by-others" />
      <Metric
        label="Monthly net"
        value={fmtPence(burn, { showSign: true })}
        hint={`avg over last 3 mo`}
        valueClass={isBurning ? 'text-red-400' : 'text-green-400'}
        icon={isBurning ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
      />
      <Metric
        label="Emergency fund"
        value={fmtPence(runway.emergencyFundPence, { abs: true })}
        hint={settings?.emergencyFund.mode === 'months' ? `${settings.emergencyFund.months} mo of burn` : 'fixed'}
      />
      <Metric
        label="Runway"
        value={`${monthsLabel} mo`}
        hint={dateLabel}
        valueClass={neverHitsFloor ? 'text-green-400' : (months as number) < 6 ? 'text-red-400' : (months as number) < 12 ? 'text-yellow-400' : 'text-text-primary'}
        icon={!neverHitsFloor && (months as number) < 12 ? <AlertTriangle size={11} /> : undefined}
      />
    </div>
  )
}

function Metric({
  label, value, hint, valueClass, icon,
}: {
  label: string; value: string; hint?: string; valueClass?: string; icon?: React.ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-0.5">{label}</div>
      <div className={`text-lg font-medium tabular-nums flex items-center gap-1 ${valueClass ?? 'text-text-primary'}`}>
        {icon}<span className="truncate">{value}</span>
      </div>
      {hint && <div className="text-[10px] text-text-tertiary mt-0.5 truncate">{hint}</div>}
    </div>
  )
}
