// Index worker — a forked child process (not a worker_thread: tsx does not map
// `.js` → `.ts` inside worker threads) that owns the SQLite connection, so
// transcript parsing (tens of MB per session) never blocks the hub's event
// loop. One request per IPC message; the DB path arrives in argv[2].

import { openDb, needsIndex, stats } from './db.js'
import { indexFile, runRead, runSearch } from './service.js'
import { statSync } from 'node:fs'

export interface WorkerRequest {
  id: number
  method: 'index' | 'search' | 'read' | 'stats' | 'needsIndex'
  params: Record<string, unknown>
}

export interface WorkerResponse {
  id: number
  result?: unknown
  error?: string
}

const db = openDb(String(process.argv[2]))

function handle(req: WorkerRequest): unknown {
  const p = req.params
  switch (req.method) {
    case 'index':
      return indexFile(db, String(p.sessionId), String(p.path), (p.meta ?? {}) as { hubName?: string; agentKey?: string }, Boolean(p.force))
    case 'needsIndex': {
      const path = String(p.path)
      const st = statSync(path)
      return needsIndex(db, String(p.sessionId), { path, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
    }
    case 'search':
      return runSearch(db, p as never)
    case 'read':
      return runRead(db, p as never)
    case 'stats':
      return stats(db)
    default:
      throw new Error(`unknown method ${String(req.method)}`)
  }
}

process.on('message', (req: WorkerRequest) => {
  let reply: WorkerResponse
  try {
    reply = { id: req.id, result: handle(req) }
  } catch (err) {
    reply = { id: req.id, error: err instanceof Error ? err.message : String(err) }
  }
  process.send!(reply)
})
// The hub died without stopping us — don't linger as an orphan.
process.on('disconnect', () => process.exit(0))
