// Live board refresh — SyncBus 'boards' service. The hub's BoardWatcher
// broadcasts `changed {boardPath}` on ANY board-file edit (an agent moving
// its card, Obsidian, Syncthing) and `transition` on review/done/#blocked.
// If the changed board is the one open in Spaces, re-read it — UNLESS a
// local mutation is being POSTed right now (boardApi sets `saving`), in
// which case our own write triggered the event and the in-memory copy is
// already the newest.
//
// Wired once at boot from GatedBoot (module-level, like meetup/subscribe).

import { hubBus } from '@/sync-bus'
import { useSpacesStore } from '@/store/spaces'

let wired = false

export function wireBoardSubscription(): void {
  if (wired) return
  wired = true

  hubBus.on('boards', 'changed', (data) => {
    const { boardPath } = data as { boardPath: string }
    const st = useSpacesStore.getState()
    if (!st.boardPath || st.boardPath !== boardPath) return
    if (st.saving) return // our own write — already current
    void st.loadBoard()
  })

  // Transitions can arrive for boards that are NOT open (rail badges etc.
  // derive from sessions, not boards, so nothing else to update here yet).
  hubBus.on('boards', 'transition', (data) => {
    const { boardPath } = data as { boardPath: string }
    const st = useSpacesStore.getState()
    if (st.boardPath === boardPath && !st.saving) void st.loadBoard()
  })

  // Reconnect: the WS was down — whatever happened meanwhile is unknown, so
  // re-read the open board.
  hubBus.onConnect(() => {
    const st = useSpacesStore.getState()
    if (st.boardPath && !st.saving) void st.loadBoard()
  })
}
