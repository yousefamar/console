// Pull-to-refresh hook for any vertical scroll container.
//
// Usage: pass the container ref + an async refresh function. While the user
// drags down from scrollTop=0, distance is tracked in the global pull store
// and rendered by <PullIndicator />. Releasing past PULL_THRESHOLD invokes
// onRefresh; the indicator shows a spinner until the promise resolves.
//
// Native overscroll is already disabled globally (`overscroll-behavior: none`
// on body in src/index.css) so we never fight the browser's own pull-to-
// refresh. Listeners are passive — we don't preventDefault, so the gesture
// stays cheap and other native-feeling behavior (momentum scroll) is intact.

import { useEffect, useRef } from 'react'
import { usePullStore, PULL_THRESHOLD } from '@/store/pull'

const MAX_PULL = 120
const DAMPING = 0.5

export function usePullToRefresh(
  containerRef: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<unknown> | unknown,
  enabled = true,
): void {
  const startY = useRef<number | null>(null)
  const pulling = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  useEffect(() => {
    if (!enabled) return
    const el = containerRef.current
    if (!el) return

    const reset = () => {
      startY.current = null
      pulling.current = false
      if (usePullStore.getState().distance !== 0) {
        usePullStore.setState({ distance: 0 })
      }
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      if (el.scrollTop > 0) return
      startY.current = e.touches[0]!.clientY
      pulling.current = false
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (startY.current == null) return
      // If the container started scrolling (e.g. fast flick) abandon the pull.
      if (el.scrollTop > 0) {
        reset()
        return
      }
      const dy = e.touches[0]!.clientY - startY.current
      if (dy <= 0) {
        if (pulling.current) usePullStore.setState({ distance: 0 })
        pulling.current = false
        return
      }
      pulling.current = true
      const damped = Math.min(MAX_PULL, dy * DAMPING)
      usePullStore.setState({ distance: damped })
    }

    const handleTouchEnd = async () => {
      const wasPulling = pulling.current
      const distance = usePullStore.getState().distance
      startY.current = null
      pulling.current = false

      if (!wasPulling || distance < PULL_THRESHOLD) {
        if (distance !== 0) usePullStore.setState({ distance: 0 })
        return
      }

      usePullStore.setState({ distance: 0, refreshing: true })
      try {
        await onRefreshRef.current()
      } catch { /* swallow — refresh failures surface via existing UI */ }
      finally {
        usePullStore.setState({ refreshing: false })
      }
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: true })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })
    el.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
      el.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [containerRef, enabled])
}
