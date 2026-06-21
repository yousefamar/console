import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { exitWithError, info, type GlobalFlags } from '../output.js'

export async function basemap(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case 'update': return basemapUpdate(args, flags)
    default:
      exitWithError('USAGE', `Unknown basemap command: ${verb}. Try 'con map basemap update [region] [maxzoom]'.`, flags)
  }
}

/** Run scripts/basemap-extract.sh to (re)generate a regional .pmtiles archive. */
async function basemapUpdate(args: string[], flags: GlobalFlags): Promise<void> {
  // commands dir → repo root is ../../.. (works for both src (tsx) and dist).
  const here = dirname(fileURLToPath(import.meta.url))
  const script = join(here, '..', '..', '..', 'scripts', 'basemap-extract.sh')
  if (!existsSync(script)) {
    return exitWithError('NOT_FOUND', `basemap-extract.sh not found at ${script}`, flags)
  }
  if (!flags.json) info(`Running ${script} ${args.join(' ')}`)
  const res = spawnSync('bash', [script, ...args], { stdio: 'inherit' })
  if (res.status !== 0) {
    return exitWithError('FAILED', `basemap extract exited with code ${res.status}`, flags)
  }
}
