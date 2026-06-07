// Hub vault root path — fetched once, cached forever (it can't change without
// a hub restart, and even then the SPA reloads). Used by agent-session
// creation in Notes context to construct the absolute cwd the hub needs.

import { hubFetch } from '@/hub'

let cached: string | null = null
let inflight: Promise<string | null> | null = null

export async function getVaultPath(): Promise<string | null> {
  if (cached !== null) return cached
  if (inflight) return inflight
  inflight = hubFetch<{ path: string }>('/notes/vault-path')
    .then((r) => { cached = r.path; return r.path })
    .catch(() => null)
    .finally(() => { inflight = null })
  return inflight
}
