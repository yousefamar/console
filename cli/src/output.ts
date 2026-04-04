// Output formatting: envelope, TTY vs JSON, table rendering, field selection

export interface Envelope<T = unknown> {
  success: boolean
  data?: T
  error?: { code: string; message: string }
  metadata?: {
    duration?: number
    pagination?: { nextPageToken?: string; total?: number }
  }
}

// Flags parsed from argv
export interface GlobalFlags {
  json: boolean
  plain: boolean
  select?: string
  noColor: boolean
  hub?: string
  agent: boolean
  dryRun: boolean
  noInput: boolean
  verbose: boolean
  timeout: number
}

export function isJsonMode(flags: GlobalFlags): boolean {
  return flags.json || flags.agent || !process.stdout.isTTY
}

// --------------------------------------------------------------------------
// Envelope wrapping
// --------------------------------------------------------------------------

export function success<T>(data: T, metadata?: Envelope['metadata']): Envelope<T> {
  return { success: true, data, metadata }
}

export function failure(code: string, message: string): Envelope {
  return { success: false, error: { code, message } }
}

// --------------------------------------------------------------------------
// Output rendering
// --------------------------------------------------------------------------

export function output(data: unknown, flags: GlobalFlags, metadata?: Envelope['metadata']): void {
  if (isJsonMode(flags)) {
    const envelope = success(applySelect(data, flags.select), metadata)
    process.stdout.write(JSON.stringify(envelope) + '\n')
  } else {
    // Human-readable: just print the data nicely
    if (typeof data === 'string') {
      process.stdout.write(data + '\n')
    } else if (Array.isArray(data)) {
      printTable(data, flags)
    } else if (data && typeof data === 'object') {
      printObject(data as Record<string, unknown>, flags)
    } else {
      process.stdout.write(String(data) + '\n')
    }
  }
}

export function outputError(code: string, message: string, flags: GlobalFlags): void {
  if (isJsonMode(flags)) {
    process.stdout.write(JSON.stringify(failure(code, message)) + '\n')
  } else {
    process.stderr.write(`Error: ${message}\n`)
  }
}

export function info(msg: string): void {
  process.stderr.write(msg + '\n')
}

// --------------------------------------------------------------------------
// Field selection (--select)
// --------------------------------------------------------------------------

function applySelect(data: unknown, select?: string): unknown {
  if (!select) return data
  const fields = select.split(',').map((f) => f.trim())

  if (Array.isArray(data)) {
    return data.map((item) => pickFields(item, fields))
  }
  if (data && typeof data === 'object') {
    return pickFields(data as Record<string, unknown>, fields)
  }
  return data
}

function pickFields(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const value = getNestedValue(obj, field)
    if (value !== undefined) {
      result[field] = value
    }
  }
  return result
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

// --------------------------------------------------------------------------
// Table rendering
// --------------------------------------------------------------------------

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  white: '\x1b[37m',
}

function c(color: keyof typeof COLORS, text: string, flags: GlobalFlags): string {
  if (flags.noColor) return text
  return `${COLORS[color]}${text}${COLORS.reset}`
}

function printTable(items: unknown[], flags: GlobalFlags): void {
  if (items.length === 0) {
    info('(no results)')
    return
  }
  // Simple key-value table for arrays of objects
  for (const item of items) {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const parts: string[] = []
      for (const [k, v] of Object.entries(obj)) {
        if (v === null || v === undefined) continue
        if (typeof v === 'object') continue // skip nested objects in table view
        parts.push(`${c('dim', k + ':', flags)} ${String(v)}`)
      }
      process.stdout.write(parts.join('  ') + '\n')
    } else {
      process.stdout.write(String(item) + '\n')
    }
  }
}

function printObject(obj: Record<string, unknown>, flags: GlobalFlags): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'object' && !Array.isArray(v)) {
      process.stdout.write(`${c('bold', k, flags)}:\n`)
      const nested = v as Record<string, unknown>
      for (const [nk, nv] of Object.entries(nested)) {
        process.stdout.write(`  ${c('dim', nk + ':', flags)} ${String(nv)}\n`)
      }
    } else if (Array.isArray(v)) {
      process.stdout.write(`${c('bold', k, flags)}: ${v.join(', ')}\n`)
    } else {
      process.stdout.write(`${c('dim', k + ':', flags)} ${String(v)}\n`)
    }
  }
}

// --------------------------------------------------------------------------
// Streaming output (NDJSON)
// --------------------------------------------------------------------------

export function outputLine(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n')
}

// --------------------------------------------------------------------------
// Exit codes
// --------------------------------------------------------------------------

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH_REQUIRED: 4,
  HUB_UNAVAILABLE: 5,
  RATE_LIMITED: 6,
  TIMEOUT: 7,
} as const

export function exitWithError(code: string, message: string, flags: GlobalFlags): never {
  outputError(code, message, flags)
  const exitCode = code === 'HUB_UNAVAILABLE' ? EXIT.HUB_UNAVAILABLE
    : code === 'AUTH_REQUIRED' ? EXIT.AUTH_REQUIRED
    : code === 'NOT_FOUND' ? EXIT.NOT_FOUND
    : code === 'RATE_LIMITED' ? EXIT.RATE_LIMITED
    : code === 'TIMEOUT' ? EXIT.TIMEOUT
    : code === 'USAGE' ? EXIT.USAGE
    : EXIT.ERROR
  process.exit(exitCode)
}
