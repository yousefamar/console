// Keeps `useBlogStore.stalePosts` current: probe the site's build time at
// boot, on hub reconnect and every few minutes (a rebuild can be triggered
// from anywhere — a PATCH, another device, an agent); re-derive on every
// vault file-list change (a save bumps the mtime → stale until the next
// build lands). Boot-wired: the Spaces rail reads it, but Spaces mounts
// lazily and the count must be right before the pane is ever opened.

import { hubBus } from '@/sync-bus'
import { useBlogStore } from '@/store/blog'
import { useNotesStore } from '@/store/notes'

const PROBE_INTERVAL_MS = 2 * 60_000
const RECOMPUTE_DEBOUNCE_MS = 300

let wired = false

export function wireStalePosts(): () => void {
  if (wired) return () => {}
  wired = true

  void useBlogStore.getState().refreshSiteBuiltAt()
  const timer = setInterval(() => { void useBlogStore.getState().refreshSiteBuiltAt() }, PROBE_INTERVAL_MS)
  const offConnect = hubBus.onConnect(() => { void useBlogStore.getState().refreshSiteBuiltAt() })

  let debounce: ReturnType<typeof setTimeout> | null = null
  let lastFiles = useNotesStore.getState().files
  const unsub = useNotesStore.subscribe((s) => {
    if (s.files === lastFiles) return
    lastFiles = s.files
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => { void useBlogStore.getState().recomputeStalePosts() }, RECOMPUTE_DEBOUNCE_MS)
  })

  return () => {
    wired = false
    clearInterval(timer)
    offConnect()
    unsub()
    if (debounce) clearTimeout(debounce)
  }
}
