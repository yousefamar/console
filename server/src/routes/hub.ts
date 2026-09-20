import type { IncomingMessage, ServerResponse } from 'node:http'

// POST /restart — graceful hub restart from a client (SPA Settings → Hub →
// Restart). Replies 202 first, then runs the SIGTERM shutdown path pm2 itself
// uses; pm2's autorestart brings the hub back and /health's `startedAt` moves.
export function handleHubRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: { restart: () => void; log: (msg: string) => void },
): boolean {
  if (path !== '/restart') return false
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return true
  }
  ctx.log('Restart requested via POST /restart')
  // Shut down only once the 202 has left the socket: shutdown() closes the
  // listener, and a reply still in flight would surface as a network error.
  res.once('finish', () => setTimeout(ctx.restart, 50))
  res.writeHead(202, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ restarting: true }))
  return true
}
