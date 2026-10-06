// /forge/* — status and manual control of the remote compute box.
//
// Deliberately thin: the interesting decisions (when to wake it, when to stop
// it, where a fork runs) belong to the hub's own lifecycle, not to a request.
// These exist so Yousef can see state and pre-warm by hand.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  forgeConfig, forgeAvailable, instanceState, ensureMaster, prewarmCwd,
  forgeExec, isCwdPrepared, stopForgeIfIdle, forgeConfigFile,
} from '../forge/index.js'

export interface ForgeRouteCtx {
  /** Remote sessions, for the status view. */
  sessions: () => Array<{ id: string; name?: string; devPort?: number | null; cwd: string }>
  /** cwds the hub currently believes are warm. */
  preparedCwds: () => string[]
  log: (m: string) => void
  readBody: (req: IncomingMessage) => Promise<string>
}

export function handleForgeRoutes(req: IncomingMessage, res: ServerResponse, path: string, ctx: ForgeRouteCtx): boolean {
  if (!path.startsWith('/forge')) return false
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const body = async <T>(): Promise<T> => {
    const raw = await ctx.readBody(req)
    return (raw ? JSON.parse(raw) : {}) as T
  }

  if (path === '/forge/status' && req.method === 'GET') {
    void (async () => {
      const cfg = forgeConfig()
      if (!cfg) {
        json(200, { configured: false, configFile: forgeConfigFile })
        return
      }
      const [state, master] = await Promise.all([instanceState(cfg), ensureMaster(cfg).catch(() => false)])
      json(200 , {
        configured: true,
        instanceId: cfg.instanceId,
        region: cfg.region,
        host: cfg.host,
        idleStopMinutes: cfg.idleStopMinutes,
        state,
        master,
        preparedCwds: ctx.preparedCwds(),
        sessions: ctx.sessions(),
      })
    })().catch((err: unknown) => json(500, { error: String(err) }))
    return true
  }

  if (path === '/forge/up' && req.method === 'POST') {
    void (async () => {
      if (!forgeAvailable()) { json(400, { error: 'forge is not configured' }); return }
      const b = await body<{ cwd?: string }>()
      const cwd = b.cwd ?? `${process.env.HOME ?? '/home/amar'}/sync/brain/root/projects/console`
      const r = await prewarmCwd(cwd, ctx.log)
      json(r.ok ? 200 : 503, { ok: r.ok, reason: r.reason, cwd, warm: isCwdPrepared(cwd) })
    })().catch((err: unknown) => json(500, { error: String(err) }))
    return true
  }

  if (path === '/forge/down' && req.method === 'POST') {
    void (async () => {
      const cfg = forgeConfig()
      if (!cfg) { json(400, { error: 'forge is not configured' }); return }
      const live = ctx.sessions().length
      if (live > 0) {
        // Refuse rather than kill work: stopping the box under a running fork
        // would strand its turn and its uncommitted worktree.
        json(409, { ok: false, reason: `${live} remote session(s) still live — close them first`, sessions: ctx.sessions() })
        return
      }
      // Force the idle check by pretending the idle window has elapsed.
      const stopped = await stopForgeIfIdle(0, ctx.log, { force: true })
      json(200, { ok: stopped, reason: stopped ? 'stopping' : 'not running' })
    })().catch((err: unknown) => json(500, { error: String(err) }))
    return true
  }

  if (path === '/forge/run' && req.method === 'POST') {
    void (async () => {
      const cfg = forgeConfig()
      if (!cfg) { json(400, { error: 'forge is not configured' }); return }
      const b = await body<{ command?: string; cwd?: string }>()
      if (!b.command) { json(400, { error: 'command is required' }); return }
      const cwd = b.cwd ? `cd '${b.cwd.replace(/'/g, `'\\''`)}' && ` : ''
      const r = await forgeExec(cfg, `${cwd}. /etc/profile.d/forge.sh >/dev/null 2>&1; ${b.command}`, { timeoutMs: 600_000 })
      json(200, r)
    })().catch((err: unknown) => json(500, { error: String(err) }))
    return true
  }

  return false
}
