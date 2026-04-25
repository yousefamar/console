import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags, readStdin } from './util.js'

export async function money(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'status': return moneyStatus(flags)
    case 'accounts': return moneyAccounts(flags)
    case 'balance': return moneyBalance(flags)
    case 'transactions': return moneyTransactions(args, flags)
    case 'get': return moneyGet(args, flags)
    case 'pots': return moneyPots(flags)
    case 'deposit': return moneyDeposit(args, flags)
    case 'withdraw': return moneyWithdraw(args, flags)
    case 'annotate': return moneyAnnotate(args, flags)
    case 'spending': return moneySpending(args, flags)
    case 'sync': return moneySync(flags)

    // Finance planner (/finance/*)
    case 'all': return financeAll(flags)
    case 'settings': return financeSettings(args, flags)
    case 'categories': return financeCategories(args, flags)
    case 'rules': return financeRules(args, flags)
    case 'fin-accounts': return financeAccounts(args, flags)
    case 'fin-balance': return financeAddBalance(args, flags)
    case 'streams': return financeStreams(args, flags)
    case 'budgets': return financeBudgets(args, flags)
    case 'scenarios': return financeScenarios(args, flags)
    case 'override': return financeOverride(args, flags)
    case 'monthly': return financeMonthly(flags)
    case 'forecast': return financeForecast(args, flags)
    case 'networth': return financeNetWorth(args, flags)
    case 'projection': return financeProjection(args, flags)
    case 'runway': return financeRunway(args, flags)
    case 'budget-status': return financeBudgetStatus(args, flags)
    case 'recurring': return financeRecurring(flags)
    case 'transfers': return financeTransferCandidates(flags)
    case 'import-csv': return financeImportCsv(args, flags)
    case 'detect-accounts': return financeDetectAccounts(flags)
    case 'apply-candidate': return financeApplyCandidate(args, flags)

    default:
      exitWithError('USAGE', `Unknown money command: ${verb}. Run 'con help money'.`, flags)
  }
}

async function moneyStatus(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/money/status')
  output(data, flags)
}

async function moneyAccounts(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/money/accounts')
  output(data, flags)
}

async function moneyBalance(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/money/balance')
  output(data, flags)
}

async function moneyTransactions(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const params: Record<string, string | undefined> = {
    since: opts.since,
    before: opts.before,
    category: opts.category,
    search: opts.search,
    limit: opts.limit || '50',
    offset: opts.offset,
  }
  const data = await hubFetch('/money/transactions', { params })
  output(data, flags)
}

async function moneyGet(args: string[], flags: GlobalFlags): Promise<void> {
  const txId = args[0]
  if (!txId) exitWithError('USAGE', 'Usage: con money get <transaction-id>', flags)
  const data = await hubFetch(`/money/transactions/${encodeURIComponent(txId)}`)
  output(data, flags)
}

async function moneyPots(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/money/pots')
  output(data, flags)
}

async function moneyDeposit(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.pot) exitWithError('USAGE', 'Usage: con money deposit --pot <pot-id> --amount <pence>', flags)
  if (!opts.amount) exitWithError('USAGE', 'Provide --amount in pence', flags)
  const data = await hubFetch(`/money/pots/${encodeURIComponent(opts.pot)}/deposit`, {
    method: 'POST',
    body: { amount: parseInt(opts.amount) },
  })
  output(data, flags)
}

async function moneyWithdraw(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.pot) exitWithError('USAGE', 'Usage: con money withdraw --pot <pot-id> --amount <pence>', flags)
  if (!opts.amount) exitWithError('USAGE', 'Provide --amount in pence', flags)
  const data = await hubFetch(`/money/pots/${encodeURIComponent(opts.pot)}/withdraw`, {
    method: 'POST',
    body: { amount: parseInt(opts.amount) },
  })
  output(data, flags)
}

async function moneyAnnotate(args: string[], flags: GlobalFlags): Promise<void> {
  const txId = args[0]
  if (!txId) exitWithError('USAGE', 'Usage: con money annotate <tx-id> --key <k> --value <v>', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.key) exitWithError('USAGE', 'Provide --key', flags)
  const data = await hubFetch(`/money/transactions/${encodeURIComponent(txId)}`, {
    method: 'PATCH',
    body: { metadata: { [opts.key]: opts.value ?? '' } },
  })
  output(data, flags)
}

async function moneySpending(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const params: Record<string, string | undefined> = { month: opts.month }
  const data = await hubFetch('/money/spending', { params })
  output(data, flags)
}

async function moneySync(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/money/sync', { method: 'POST' })
  output(data, flags)
}

// --------------------------------------------------------------------------
// Finance planner (/finance/*)
// --------------------------------------------------------------------------

async function financeAll(flags: GlobalFlags): Promise<void> {
  const data = await hubFetch('/finance/all')
  output(data, flags)
}

async function financeSettings(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.length === 0) { output(await hubFetch('/finance/settings'), flags); return }
  const opts = parseFlags(args)
  const patch: Record<string, unknown> = {}
  if (opts.horizon) patch.projectionHorizonMonths = parseInt(opts.horizon, 10)
  if (opts['investment-growth']) patch.investmentGrowthPct = parseFloat(opts['investment-growth'])
  if (opts['emergency-months']) patch.emergencyFund = { mode: 'months', months: parseInt(opts['emergency-months'], 10) }
  if (opts['emergency-fixed']) patch.emergencyFund = { mode: 'fixed', valuePence: Math.round(parseFloat(opts['emergency-fixed']) * 100) }
  output(await hubFetch('/finance/settings', { method: 'PATCH', body: patch }), flags)
}

async function financeCategories(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'list') { output(await hubFetch('/finance/categories'), flags); return }
  if (sub === 'add') {
    const opts = parseFlags(args.slice(1))
    if (!opts.name) exitWithError('USAGE', 'Usage: con money categories add --name <name> [--emoji 🏷️ --color #abc --kind expense|income|transfer --variable]', flags)
    const body = { name: opts.name, emoji: opts.emoji, color: opts.color, kind: opts.kind ?? 'expense', variable: opts.variable ? true : opts.variable === 'false' ? false : undefined }
    output(await hubFetch('/finance/categories', { method: 'POST', body: body }), flags)
    return
  }
  if (sub === 'delete') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money categories delete <id>', flags)
    output(await hubFetch(`/finance/categories/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
    return
  }
  exitWithError('USAGE', `Unknown categories subcommand: ${sub}`, flags)
}

async function financeRules(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'list') { output(await hubFetch('/finance/rules'), flags); return }
  if (sub === 'add') {
    const opts = parseFlags(args.slice(1))
    if (!opts.category) exitWithError('USAGE', 'Provide --category <id> and at least one match flag (--merchant / --description / --counterparty / --monzo-cat / --sign in|out)', flags)
    const body = {
      priority: opts.priority ? parseInt(opts.priority, 10) : 50,
      label: opts.label,
      categoryId: opts.category,
      ignore: opts.ignore === 'true',
      asTransfer: opts.transfer === 'true',
      match: {
        merchantContains: opts.merchant,
        descriptionContains: opts.description,
        counterpartyContains: opts.counterparty,
        monzoCategoryEquals: opts['monzo-cat'],
        amountSign: opts.sign as 'in' | 'out' | undefined,
      },
      sharedFraction: opts.shared !== undefined ? Math.max(0, Math.min(1, parseFloat(opts.shared))) : undefined,
      sharedWithCounterparty: opts['shared-with'],
    }
    output(await hubFetch('/finance/rules', { method: 'POST', body: body }), flags)
    return
  }
  if (sub === 'delete') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money rules delete <id>', flags)
    output(await hubFetch(`/finance/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
    return
  }
  exitWithError('USAGE', `Unknown rules subcommand: ${sub}`, flags)
}

async function financeAccounts(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'list') { output(await hubFetch('/finance/accounts'), flags); return }
  if (sub === 'add') {
    const opts = parseFlags(args.slice(1))
    if (!opts.name) exitWithError('USAGE', 'Usage: con money fin-accounts add --name <name> --type manual|monzo --liquidity liquid|investment|illiquid [--emoji X --external]', flags)
    const body = {
      name: opts.name,
      type: opts.type ?? 'manual',
      liquidity: opts.liquidity ?? 'liquid',
      currency: opts.currency ?? 'GBP',
      emoji: opts.emoji,
      isExternal: opts.external === 'true',
      notes: opts.notes,
      growthPctYoy: opts.growth ? parseFloat(opts.growth) : undefined,
    }
    output(await hubFetch('/finance/accounts', { method: 'POST', body: body }), flags)
    return
  }
  if (sub === 'patch') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money fin-accounts patch <id> [--growth N --liquidity X --emoji Y --external true ...]', flags)
    const opts = parseFlags(args.slice(2))
    const patch: Record<string, unknown> = {}
    if (opts.name) patch.name = opts.name
    if (opts.liquidity) patch.liquidity = opts.liquidity
    if (opts.emoji) patch.emoji = opts.emoji
    if (opts.external === 'true' || opts.external === 'false') patch.isExternal = opts.external === 'true'
    if (opts.notes) patch.notes = opts.notes
    if (opts.growth !== undefined) patch.growthPctYoy = opts.growth === '' ? undefined : parseFloat(opts.growth)
    output(await hubFetch(`/finance/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }), flags)
    return
  }
  if (sub === 'delete') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money fin-accounts delete <id>', flags)
    output(await hubFetch(`/finance/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
    return
  }
  exitWithError('USAGE', `Unknown fin-accounts subcommand: ${sub}`, flags)
}

async function financeAddBalance(args: string[], flags: GlobalFlags): Promise<void> {
  const id = args[0]
  if (!id) exitWithError('USAGE', 'Usage: con money fin-balance <account-id> --pounds <n> [--date YYYY-MM-DD --note "..."]', flags)
  const opts = parseFlags(args.slice(1))
  if (!opts.pounds && !opts.pence) exitWithError('USAGE', 'Provide --pounds or --pence', flags)
  const balancePence = opts.pence ? parseInt(opts.pence, 10) : Math.round(parseFloat(opts.pounds) * 100)
  const body = { date: opts.date ?? new Date().toISOString().slice(0, 10), balancePence, note: opts.note }
  output(await hubFetch(`/finance/accounts/${encodeURIComponent(id)}/balance`, { method: 'POST', body: body }), flags)
}

async function financeStreams(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'list') { output(await hubFetch('/finance/streams'), flags); return }
  if (sub === 'add') {
    const opts = parseFlags(args.slice(1))
    if (!opts.name || (!opts.pounds && !opts.pence)) exitWithError('USAGE', 'Usage: con money streams add --name <n> --kind income|expense --pounds <n> --cadence monthly|yearly|weekly [--day N --month N --start YYYY-MM-DD --end YYYY-MM-DD --category <id> --account <id> --growth <pct>]', flags)
    const body = {
      name: opts.name,
      kind: opts.kind ?? 'expense',
      amountPence: opts.pence ? parseInt(opts.pence, 10) : Math.round(parseFloat(opts.pounds) * 100),
      cadence: opts.cadence ?? 'monthly',
      dayOfMonth: opts.day ? parseInt(opts.day, 10) : undefined,
      monthOfYear: opts.month ? parseInt(opts.month, 10) : undefined,
      startDate: opts.start ?? new Date().toISOString().slice(0, 10),
      endDate: opts.end,
      categoryId: opts.category,
      accountId: opts.account,
      growthPctYoy: opts.growth ? parseFloat(opts.growth) : undefined,
      notes: opts.notes,
    }
    output(await hubFetch('/finance/streams', { method: 'POST', body: body }), flags)
    return
  }
  if (sub === 'delete') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money streams delete <id>', flags)
    output(await hubFetch(`/finance/streams/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
    return
  }
  exitWithError('USAGE', `Unknown streams subcommand: ${sub}`, flags)
}

async function financeBudgets(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'list') { output(await hubFetch('/finance/budgets'), flags); return }
  if (sub === 'set') {
    const opts = parseFlags(args.slice(1))
    if (!opts.category || (!opts.pounds && !opts.pence)) exitWithError('USAGE', 'Usage: con money budgets set --category <id> --pounds <n>', flags)
    const body = {
      categoryId: opts.category,
      monthlyTargetPence: opts.pence ? parseInt(opts.pence, 10) : Math.round(parseFloat(opts.pounds) * 100),
      rollover: opts.rollover === 'true',
    }
    output(await hubFetch('/finance/budgets', { method: 'POST', body: body }), flags)
    return
  }
  if (sub === 'delete') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money budgets delete <id>', flags)
    output(await hubFetch(`/finance/budgets/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
    return
  }
  exitWithError('USAGE', `Unknown budgets subcommand: ${sub}`, flags)
}

async function financeScenarios(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (!sub || sub === 'list') { output(await hubFetch('/finance/scenarios'), flags); return }
  if (sub === 'add') {
    const opts = parseFlags(args.slice(1))
    if (!opts.name) exitWithError('USAGE', 'Usage: con money scenarios add --name <n> [--description "..."]', flags)
    output(await hubFetch('/finance/scenarios', {
      method: 'POST',
      body: { name: opts.name, description: opts.description, deltas: [] },
    }), flags)
    return
  }
  if (sub === 'set-deltas') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money scenarios set-deltas <id> < deltas.json', flags)
    const deltasJson = await readStdin()
    const deltas = JSON.parse(deltasJson)
    output(await hubFetch(`/finance/scenarios/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { deltas },
    }), flags)
    return
  }
  if (sub === 'delete') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money scenarios delete <id>', flags)
    output(await hubFetch(`/finance/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
    return
  }
  exitWithError('USAGE', `Unknown scenarios subcommand: ${sub}`, flags)
}

async function financeOverride(args: string[], flags: GlobalFlags): Promise<void> {
  const sub = args[0]
  if (sub === 'set') {
    const opts = parseFlags(args.slice(1))
    if (!opts.tx) exitWithError('USAGE', 'Usage: con money override set --tx <id> [--category <id> --ignore --transfer]', flags)
    output(await hubFetch('/finance/overrides', {
      method: 'POST',
      body: {
        txId: opts.tx,
        categoryId: opts.category,
        ignore: opts.ignore === 'true',
        pairedTxId: opts.paired,
      },
    }), flags)
    return
  }
  if (sub === 'clear') {
    const id = args[1]
    if (!id) exitWithError('USAGE', 'Usage: con money override clear <tx-id>', flags)
    output(await hubFetch(`/finance/overrides/${encodeURIComponent(id)}`, { method: 'DELETE' }), flags)
    return
  }
  if (!sub || sub === 'list') { output(await hubFetch('/finance/overrides'), flags); return }
  exitWithError('USAGE', `Unknown override subcommand: ${sub}`, flags)
}

async function financeMonthly(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/finance/monthly'), flags)
}

async function financeForecast(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const params = { window: opts.window ?? '3' }
  output(await hubFetch('/finance/variable-forecast', { params }), flags)
}

async function financeNetWorth(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (opts.history) {
    output(await hubFetch('/finance/networth/history', { params: { months: opts.months ?? '12' } }), flags)
    return
  }
  output(await hubFetch('/finance/networth', { params: { date: opts.date } }), flags)
}

async function financeProjection(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  output(await hubFetch('/finance/projection', { params: { horizon: opts.horizon, scenario: opts.scenario, window: opts.window } }), flags)
}

async function financeRunway(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const data = await hubFetch<{ runway: unknown }>('/finance/projection', { params: { horizon: opts.horizon ?? '60', scenario: opts.scenario } })
  output(data.runway, flags)
}

async function financeBudgetStatus(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  output(await hubFetch('/finance/budget-status', { params: { month: opts.month } }), flags)
}

async function financeRecurring(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/finance/recurring/candidates'), flags)
}

async function financeTransferCandidates(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/finance/transfers/candidates'), flags)
}

async function financeImportCsv(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  const path = opts.path ?? args[0]
  if (!path) exitWithError('USAGE', 'Usage: con money import-csv <path-or-stdin> [--overwrite]', flags)
  const body = path === '-' ? { csv: await readStdin() } : { path, overwrite: opts.overwrite === 'true' }
  output(await hubFetch('/finance/import/monzo-csv', { method: 'POST', body: body }), flags)
}

async function financeDetectAccounts(flags: GlobalFlags): Promise<void> {
  output(await hubFetch('/finance/import/account-candidates'), flags)
}

async function financeApplyCandidate(args: string[], flags: GlobalFlags): Promise<void> {
  // Accepts a JSON body on stdin: { key, name, liquidity, isExternal?, emoji?, ledger: [...] }
  const json = await readStdin()
  if (!json) exitWithError('USAGE', 'Pipe candidate JSON on stdin: con money apply-candidate < cand.json', flags)
  output(await hubFetch('/finance/import/apply-candidate', { method: 'POST', body: JSON.parse(json) }), flags)
}

