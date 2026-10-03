// Recall worker — a forked child process (not a worker_thread: tsx does not map
// `.js` → `.ts` inside worker threads), so transcript parsing (tens of MB per
// session) never blocks the hub's event loop. One request per IPC message; the
// DB path arrives in argv[2], the role in argv[3]: `index` owns the writable
// connection (index/needsIndex), `query` holds a read-only one (search/read/
// stats) so a long re-index never queues a search behind it.

import type { DatabaseSync } from 'node:sqlite'
import { openDb, openReadDb, needsIndex, stats } from './db.js'
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

export type WorkerRole = 'index' | 'query'
const role: WorkerRole = process.argv[3] === 'query' ? 'query' : 'index'
const db: DatabaseSync = role === 'query' ? openReadDb(String(process.argv[2])) : openDb(String(process.argv[2]))
const WRITES = new Set<WorkerRequest['method']>(['index', 'needsIndex'])

function handle(req: WorkerRequest): unknown {
  const p = req.params
  if (role === 'query' && WRITES.has(req.method)) throw new Error(`${req.method} sent to the read-only query worker`)
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
