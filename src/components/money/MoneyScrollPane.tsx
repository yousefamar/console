import { useRef, type ReactNode } from 'react'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { useMoneyStore } from '@/store/money'
import { useFinanceStore } from '@/store/finance'

// Shared scroll wrapper for money sub-views. Pull-to-refresh on mobile
// triggers Monzo + finance reload — all sub-views share the same data
// pipeline, so a single refresh action is correct everywhere.
export function MoneyScrollPane({
  children,
  className = 'flex-1 min-h-0 overflow-y-auto',
}: {
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  usePullToRefresh(ref, async () => {
    await useMoneyStore.getState().refreshSync()
    await useFinanceStore.getState().fetchAll()
  }, isMobile)
  return <div ref={ref} className={className}>{children}</div>
}
