// Hub lifecycle commands — restart, etc.

import { spawn } from 'node:child_process'
import { output, info, exitWithError, type GlobalFlags } from '../output.js'
import { hubHealth } from '../client.js'

export async function hub(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'restart': return hubRestart(args, flags)
    default:
      exitWithError('USAGE', `Unknown hub command: ${verb}. Run 'con help hub'.`, flags)
  }
}

async function hubRestart(_args: string[], flags: GlobalFlags): Promise<void> {
  // Restart via pm2 — the hub runs as the `console-server` pm2 process.
  // Any in-progress (running) agent sessions will be persisted in the manifest
  // with wasRunning=true; on boot the hub nudges them with a continuation
  // prompt so work resumes automatically.
  if (!flags.json) info('Restarting hub via pm2...')

  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn('pm2', ['restart', 'console-server'], {
      stdio: flags.json ? 'ignore' : 'inherit',
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })

  if (!ok) {
    exitWithError('ERROR', 'pm2 restart failed. Is pm2 installed and console-server managed by it?', flags)
  }

  // Wait for the hub to come back up (poll /health for up to 15s).
  const deadline = Date.now() + 15_000
  let healthy = false
  let version: string | undefined
  while (Date.now() < deadline) {
    try {
      const h = await hubHealth()
      if (h.ok) { healthy = true; version = h.version; break }
    } catch {
      // Still restarting — keep polling
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  if (!healthy) {
    exitWithError('HUB_UNAVAILABLE', 'Hub did not become healthy within 15s of restart.', flags)
  }

  output({ restarted: true, version }, flags)
}
