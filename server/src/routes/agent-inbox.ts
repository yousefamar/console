// Agent mailbox provisioning (`con agent inbox …`).
//
//   GET    /agents/inbox                 local *-mail configs ⋈ mxroute accounts for the domain
//   POST   /agents/inbox                 {name, domain?, fromName?, signature?, quotaMb?, password?, agentKey?, project?, quiet?}
//   DELETE /agents/inbox/<name>[?keep=1] undo: mxroute account (unless keep), .env, watcher, listeners, SKILL.md
//
// 503 UNCONFIGURED until `~/.config/console/mxroute.env` carries MXROUTE_SERVER /
// MXROUTE_USERNAME / MXROUTE_API_KEY (key from panel.mxroute.com → Advanced → API Keys).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { InboxError, listInboxes, provisionInbox, removeInbox, type InboxDeps, type ProvisionInboxInput } from '../agents/inbox.js'
import { MxrouteError } from '../mxroute/client.js'

export interface AgentInboxRouteCtx {
  /** null until mxroute.env exists — re-read per request so adding the file needs no restart. */
  deps: () => Omit<InboxDeps, 'mxroute'> & { mxroute: InboxDeps['mxroute'] | null }
  mxrouteEnvFile: string
}

export function handleAgentInboxRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  ctx: AgentInboxRouteCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path !== '/agents/inbox' && !path.startsWith('/agents/inbox/')) return false
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const fail = (err: unknown) => {
    if (err instanceof InboxError) return json({ success: false, error: { code: err.code, message: err.message } }, err.status)
    if (err instanceof MxrouteError) return json({ success: false, error: { code: `MXROUTE_${err.code}`, message: `mxroute: ${err.message}${err.field ? ` (${err.field})` : ''}` } }, err.status >= 400 && err.status < 600 ? err.status : 502)
    return json({ success: false, error: { code: 'ERROR', message: (err as Error).message } }, 500)
  }
  const raw = ctx.deps()
  if (!raw.mxroute) {
    json({ success: false, error: { code: 'UNCONFIGURED', message: `mxroute API not configured: write ${ctx.mxrouteEnvFile} (chmod 600) with MXROUTE_SERVER=<mail server hostname, e.g. blizzard.mxrouting.net>, MXROUTE_USERNAME=<DirectAdmin username>, MXROUTE_API_KEY=<panel.mxroute.com → Advanced → API Keys>[, MXROUTE_DOMAIN=amar.io]. No restart needed.` } }, 503)
    return true
  }
  const deps = raw as InboxDeps

  if (path === '/agents/inbox' && req.method === 'GET') {
    listInboxes(deps).then((r) => json({ success: true, data: r })).catch(fail)
    return true
  }

  if (path === '/agents/inbox' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const input = JSON.parse(body || '{}') as ProvisionInboxInput
      if (!input.name) throw new InboxError('VALIDATION', 'name is required')
      json({ success: true, data: await provisionInbox(input, deps) }, 201)
    }).catch(fail)
    return true
  }

  const m = /^\/agents\/inbox\/([a-z0-9._-]+)$/.exec(path)
  if (m && req.method === 'DELETE') {
    removeInbox(m[1]!, { keepMailbox: url.searchParams.get('keep') === '1', domain: url.searchParams.get('domain') ?? undefined }, deps)
      .then((r) => json({ success: true, data: r })).catch(fail)
    return true
  }
  return false
}
