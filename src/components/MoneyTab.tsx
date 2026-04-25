// MoneyTab — sub-tab router for the financial planning subsystem.
//
// Tabs (in order of importance for the user's goal of "is my runway OK?"):
//   Cashflow  — runway headline, projection chart, recurring streams, scenarios switcher
//   Net worth — accounts, balance ledger, history chart
//   Budgets   — per-category target vs actual
//   Scenarios — what-if editor + comparison
//   Categories — categories + auto-categorisation rules
//   Transactions — original 3-pane forensic view
//
// The Monzo OAuth + sync flow is unchanged; the new financial-planning data
// lives under /finance/* and is independent from /money/* (Monzo proxy).

import { memo, useEffect, useState } from 'react'
import { Loader2, PoundSterling, TrendingUp, PieChart, Wallet, Beaker, Tag, Receipt } from 'lucide-react'
import { useMoneyStore } from '@/store/money'
import { useFinanceStore, type MoneySubTab } from '@/store/finance'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { getHubUrl, hubFetch } from '@/hub'
import { TransactionsView } from './money/TransactionsView'
import { CashflowView } from './money/CashflowView'
import { NetWorthView } from './money/NetWorthView'
import { CategoriesView } from './money/CategoriesView'
import { BudgetsView } from './money/BudgetsView'
import { ScenariosView } from './money/ScenariosView'

const TABS: Array<{ id: MoneySubTab; label: string; icon: React.ReactNode }> = [
  { id: 'cashflow', label: 'Cashflow', icon: <TrendingUp size={13} /> },
  { id: 'networth', label: 'Net worth', icon: <Wallet size={13} /> },
  { id: 'budgets', label: 'Budgets', icon: <PieChart size={13} /> },
  { id: 'scenarios', label: 'Scenarios', icon: <Beaker size={13} /> },
  { id: 'categories', label: 'Categories', icon: <Tag size={13} /> },
  { id: 'transactions', label: 'Transactions', icon: <Receipt size={13} /> },
]

export const MoneyTab = memo(function MoneyTab() {
  const status = useMoneyStore((s) => s.status)
  const loading = useMoneyStore((s) => s.loading)
  const fetchStatus = useMoneyStore((s) => s.fetchStatus)
  const fetchAll = useMoneyStore((s) => s.fetchAll)
  const fetchFinanceAll = useFinanceStore((s) => s.fetchAll)
  const activeSubTab = useFinanceStore((s) => s.activeSubTab)
  const setSubTab = useFinanceStore((s) => s.setSubTab)
  const isMobile = useIsMobile()

  useEffect(() => {
    fetchStatus().then(() => {
      const st = useMoneyStore.getState().status
      if (st?.connected) {
        fetchAll()
        fetchFinanceAll()
      }
    })
  }, [])

  if (status && !status.connected) {
    return <MoneyConnect hasCredentials={status.hasCredentials} />
  }

  if (loading && !useMoneyStore.getState().transactions.length) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
        <span className="text-xs text-text-tertiary ml-2">Loading…</span>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex-shrink-0 border-b border-border px-2 flex overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs whitespace-nowrap border-b-2 -mb-[1px] transition-colors ${
              activeSubTab === t.id
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {activeSubTab === 'cashflow' && <CashflowView />}
      {activeSubTab === 'networth' && <NetWorthView />}
      {activeSubTab === 'budgets' && <BudgetsView />}
      {activeSubTab === 'scenarios' && <ScenariosView />}
      {activeSubTab === 'categories' && <CategoriesView />}
      {activeSubTab === 'transactions' && <TransactionsView isMobile={isMobile} />}
    </div>
  )
})

// --- Connect (unchanged from before, kept inline for this file's autonomy) --

function MoneyConnect({ hasCredentials }: { hasCredentials: boolean }) {
  const [settingUp, setSettingUp] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  const saveCredentials = async () => {
    await hubFetch('/auth/monzo/credentials', {
      method: 'POST',
      body: JSON.stringify({ clientId, clientSecret }),
    })
    await useMoneyStore.getState().fetchStatus()
  }

  const startAuth = () => {
    window.open(`${getHubUrl()}/auth/monzo/start`, '_blank')
    const poll = setInterval(async () => {
      await useMoneyStore.getState().fetchStatus()
      const st = useMoneyStore.getState().status
      if (st?.connected) {
        clearInterval(poll)
        await useMoneyStore.getState().refreshSync()
      }
    }, 3000)
  }

  if (!hasCredentials && !settingUp) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <PoundSterling size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">Connect Monzo</p>
        <p className="text-xs text-text-tertiary max-w-xs">
          Link your Monzo account to view transactions, manage pots, and seed the financial planner.
        </p>
        <button onClick={() => setSettingUp(true)}
          className="mt-1 px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border">
          Set Up Monzo
        </button>
      </div>
    )
  }
  if (!hasCredentials && settingUp) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center px-4 max-w-sm mx-auto">
        <PoundSterling size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">Monzo API Credentials</p>
        <p className="text-xs text-text-tertiary">
          Enter your Monzo OAuth client credentials from{' '}
          <a href="https://developers.monzo.com" target="_blank" rel="noreferrer" className="underline">developers.monzo.com</a>
        </p>
        <input type="text" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary" />
        <input type="password" placeholder="Client Secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-surface-2 border border-border rounded-sm text-text-primary" />
        <div className="flex gap-2">
          <button onClick={() => setSettingUp(false)}
            className="px-3 py-1.5 text-xs bg-surface-2 text-text-secondary rounded-sm border border-border hover:bg-surface-1">Cancel</button>
          <button onClick={saveCredentials} disabled={!clientId || !clientSecret}
            className="px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm border border-border hover:bg-surface-1 disabled:opacity-50">
            Save
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
      <PoundSterling size={24} className="text-text-tertiary" />
      <p className="text-sm text-text-secondary">Connect Monzo</p>
      <p className="text-xs text-text-tertiary max-w-xs">
        Authorize Console to access your Monzo account. You'll need to approve in the Monzo app.
      </p>
      <button onClick={startAuth}
        className="mt-1 px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border">
        Connect Monzo
      </button>
    </div>
  )
}
