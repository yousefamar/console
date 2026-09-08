---
name: finance
description: Console's financial-planning subsystem (/finance/*): the finance-*.json files (categories, rules, overrides, accounts + balance ledgers, streams, budgets, scenarios, settings), the pure projection engine, CRUD + computed routes, net-worth reconstruction, scenario UX, charts. Use when touching server/src/finance, routes/finance.ts or the Money tab's Budgets/Scenarios/Categories views.
paths: server/src/finance/**, server/src/routes/finance.ts, src/components/money/**, src/store/finance.ts
user-invocable: false
---

# Financial planner

Moved out of `CLAUDE.md` on 2026-09-08 (the CLAUDE.md diet, ^rosy-owl) — the text below is the trimmed reference that used to load into every request. The CLAUDE.md stanza for this subsystem keeps only the cross-cutting invariants; treat THIS file as the authoritative detail and keep it current the way you would CLAUDE.md.

- **Financial-planning subsystem (`/finance/*`)** — independent from `/money/*`. All data persisted as JSON files under `~/.config/console/`:
  - `finance-categories.json` — user-defined (income/expense/transfer), seeded with 16 sensible defaults; replaces Monzo's 10 generic ones.
  - `finance-rules.json` — auto-categorisation: priority-ordered, conditions are AND-ed (`merchantContains`, `descriptionContains`, `counterpartyContains`, `amountSign`, `monzoCategoryEquals`). First match wins. Default rules map Monzo categories onto user categories.
  - `finance-tx-overrides.json` — per-transaction override (set category, mark ignore, mark transfer). Beats rules.
  - `finance-accounts.json` — Monzo (auto-balance) + manual accounts. Manual accounts have a balance ledger (`{date, balancePence, note}[]`) — interpolated for "balance on date X". Liquidity tag (liquid|investment|illiquid) gates inclusion in runway. `isExternal: true` = held-by-someone-else (e.g. money in someone else's ISA — counts toward net worth, not directly drawable).
  - `finance-streams.json` — recurring income/expense (`monthly|yearly|weekly`, optional `dayOfMonth`/`monthOfYear`, `growthPctYoy` for compounding annual growth, `startDate`/`endDate`).
  - `finance-budgets.json` — per-category monthly target.
  - `finance-scenarios.json` — what-if editor: baseline + ordered list of `Delta`s (`addStream | modifyStream | terminateStream | oneOff | categoryAdjust | investmentGrowth`).
  - `finance-settings.json` — emergency fund (`{mode:'fixed'|'months', valuePence|months}`), `projectionHorizonMonths`, `investmentGrowthPct`.
- **Pure projection engine** (`server/src/finance/projection.ts`):
  - `effectiveCategory(tx, rules, overrides)` — single source of truth for "what category is this transaction".
  - `aggregateMonthlySpend()` → per-month `byCategory` (positive = outflow, negative = inflow). Skips ignored + transfers.
  - `trailingCategoryAverage(monthly, windowMonths=3)` — variable-spend forecast input.
  - `streamAmountForMonth(stream, 'YYYY-MM')` — handles cadence + compounding growth.
  - `project({startMonth, horizonMonths, openingLiquid, openingInvestment, streams, variableForecast, categories, emergencyFund, investmentGrowthPct, scenario})` → `MonthlyPoint[]`. Variable spend skips categories already covered by an active fixed (non-variable) stream — prevents double-counting rent.
  - `summariseRunway()` → `{monthsToFloor, floorDate, monthsToZero, ...}` — walks the trajectory; first month liquid drops below the emergency floor wins.
  - `detectRecurring(txns)` — clusters by (label, ±50p amount band), requires ≥3 occurrences across ≥3 months. Surfaced in CashflowView as "Detected recurring".
  - `findTransferCandidates(txns, overrides)` — opposite-sign equal-amount within 3 days; UI for confirmation pending.
  - `manualBalanceLookup(account)` — latest entry on or before date; before-first-entry returns earliest known.
- **Routes** (`server/src/routes/finance.ts`):
  - CRUD: `/finance/{categories,rules,accounts,streams,budgets,scenarios,overrides,settings}` (POST = create, PATCH `/:id` = update, DELETE `/:id`). Manual ledger: `POST /finance/accounts/:id/balance`, `DELETE /finance/accounts/:id/balance/:entryId`.
  - Computed: `/finance/all`, `/finance/categorise?limit=N`, `/finance/monthly`, `/finance/variable-forecast?window=N`, `/finance/networth[?date=YYYY-MM-DD]`, `/finance/networth/history?months=N`, `/finance/projection?horizon=N&scenario=ID`, `/finance/budget-status?month=YYYY-MM`, `/finance/recurring/candidates`, `/finance/transfers/candidates`.
- **Net-worth historical reconstruction**: hub takes Monzo's live `total_balance` as "today" and walks cached transactions backward in time to reconstruct past balances (`balance(t-1) = balance(t) - delta`). Manual accounts use the ledger directly.
- **Investment growth** applies monthly to the investment portion of the projection at the rate from settings (default 5%/yr). A scenario's `investmentGrowth` delta overrides it.
- **Scenario UX**: live in `src/components/money/ScenariosView.tsx` and CashflowView. Comparison chart overlays every saved scenario's liquid trajectory on the baseline. The "active scenario" picker on Cashflow highlights one for focused view; saved scenarios persist independent of active selection.
- **Charts**: `recharts` (~3.8). Tailwind 4 `var(--color-*)` tokens for axes/grid/tooltip so dark mode just works. `RunwayCard` is a 5-tile metric strip. `ProjectionChart` = liquid+total lines with emergency reference. `NetWorthView` history = stacked area liquid+investment.
