// Append-only log of every search/read — the evidence for the "was it worth
// it?" review (who asked, what for, how many hits, did a read follow).

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface QlogEntry {
  ts: string
  tool: 'search' | 'read'
  /** X-Console-Agent of the caller, if any */
  agentKey: string
  /** caller's claudeSessionId when the hub could resolve it */
  session: string
  cwd: string
  query: string
  params: Record<string, unknown>
  hits: number | null
  ms: number
  error?: string
}

export class QueryLog {
  constructor(private file: string) {}

  append(entry: QlogEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
    } catch { /* a lost log line never fails a query */ }
  }
}
