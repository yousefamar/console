// Module-local state for pull-to-refresh visual feedback. Updated by the
// usePullToRefresh hook; consumed by the global <PullIndicator /> mounted
// in Layout. Single instance — only one container can be pulled at a time.

import { create } from 'zustand'

interface PullState {
  /** Current pull distance in px (already damped). 0 when not pulling. */
  distance: number
  /** Refresh callback is in-flight. */
  refreshing: boolean
}

export const usePullStore = create<PullState>(() => ({
  distance: 0,
  refreshing: false,
}))

/** Threshold (px) past which release triggers a refresh. */
export const PULL_THRESHOLD = 70
