import { hubFetch } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'
import { parseFlags } from './util.js'

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
    body: JSON.stringify({ amount: parseInt(opts.amount) }),
  })
  output(data, flags)
}

async function moneyWithdraw(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseFlags(args)
  if (!opts.pot) exitWithError('USAGE', 'Usage: con money withdraw --pot <pot-id> --amount <pence>', flags)
  if (!opts.amount) exitWithError('USAGE', 'Provide --amount in pence', flags)
  const data = await hubFetch(`/money/pots/${encodeURIComponent(opts.pot)}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ amount: parseInt(opts.amount) }),
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
    body: JSON.stringify({ metadata: { [opts.key]: opts.value ?? '' } }),
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
