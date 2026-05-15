import { useRef, useCallback, type RefObject } from 'react'

interface SwipeConfig {
  onSwipeRight?: () => void
  onSwipeLeft?: () => void
  onSwipeStart?: () => void
  onSwipeEnd?: () => void
  threshold?: number
  /** Ref to left-side icon element (shown when swiping right) */
  leftIconRef?: RefObject<HTMLDivElement | null>
  /** Ref to right-side icon element (shown when swiping left) */
  rightIconRef?: RefObject<HTMLDivElement | null>
}

interface SwipeState {
  startX: number
  startY: number
  currentX: number
  swiping: boolean
  direction: 'horizontal' | 'vertical' | null
  /** True when the touch began inside a horizontally-scrollable element (or
   *  one explicitly opted out via data-no-swipe). Suppresses swipe entirely so
   *  the inner scroller can handle the gesture. */
  suppressed: boolean
}

/** Walk up from `el` looking for an ancestor that has either:
 *   - `data-no-swipe` attribute (explicit opt-out), or
 *   - actual horizontal overflow (scrollWidth > clientWidth) AND a CSS
 *     overflow-x of auto/scroll.
 *  Stops at `boundary` (typically the swipe content element). */
function startsInsideHScroller(el: EventTarget | null, boundary: HTMLElement | null): boolean {
  let node = el as HTMLElement | null
  while (node && node !== boundary) {
    if (node.dataset?.noSwipe !== undefined) return true
    if (node.scrollWidth > node.clientWidth) {
      const ox = getComputedStyle(node).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    node = node.parentElement
  }
  return false
}

export function useSwipeActions(
  containerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  config: SwipeConfig,
) {
  const state = useRef<SwipeState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    swiping: false,
    direction: null,
    suppressed: false,
  })

  const threshold = config.threshold ?? 120

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]!
    // If the touch started inside a horizontal scroller (e.g. wide markdown
    // table, code block with overflow-x:auto), let that scroller win.
    const suppressed = startsInsideHScroller(e.target, contentRef.current)
    state.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      swiping: false,
      direction: null,
      suppressed,
    }
  }, [contentRef])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]!
    const s = state.current
    if (s.suppressed) return
    const dx = touch.clientX - s.startX
    const dy = touch.clientY - s.startY

    // Determine direction on first significant move
    if (!s.direction) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        s.direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
        if (s.direction === 'horizontal') {
          config.onSwipeStart?.()
        }
      }
    }

    // Only handle horizontal swipes
    if (s.direction !== 'horizontal') return

    e.preventDefault()
    s.swiping = true
    s.currentX = touch.clientX

    const content = contentRef.current
    const container = containerRef.current
    if (!content || !container) return

    const progress = Math.min(Math.abs(dx) / threshold, 1)
    content.style.transform = `translateX(${dx}px)`
    content.style.transition = 'none'

    // Show color hints: right = green (archive), left = amber (snooze)
    if (dx > 0) {
      container.style.backgroundColor = `rgba(34, 197, 94, ${progress * 0.3})`
      if (config.leftIconRef?.current) config.leftIconRef.current.style.opacity = `${progress}`
      if (config.rightIconRef?.current) config.rightIconRef.current.style.opacity = '0'
    } else {
      container.style.backgroundColor = `rgba(245, 158, 11, ${progress * 0.3})`
      if (config.rightIconRef?.current) config.rightIconRef.current.style.opacity = `${progress}`
      if (config.leftIconRef?.current) config.leftIconRef.current.style.opacity = '0'
    }
  }, [contentRef, containerRef, threshold, config])

  const onTouchEnd = useCallback(() => {
    const s = state.current
    const content = contentRef.current
    const container = containerRef.current

    config.onSwipeEnd?.()

    const resetIcons = () => {
      if (config.leftIconRef?.current) config.leftIconRef.current.style.opacity = '0'
      if (config.rightIconRef?.current) config.rightIconRef.current.style.opacity = '0'
    }

    if (!s.swiping || !content || !container) {
      if (content) {
        content.style.transform = ''
        content.style.transition = ''
      }
      if (container) container.style.backgroundColor = ''
      resetIcons()
      return
    }

    const dx = s.currentX - s.startX
    const pastThreshold = Math.abs(dx) > threshold

    if (pastThreshold) {
      // Animate off-screen
      const direction = dx > 0 ? 1 : -1
      content.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out'
      content.style.transform = `translateX(${direction * window.innerWidth}px)`
      content.style.opacity = '0'

      setTimeout(() => {
        if (dx > 0 && config.onSwipeRight) {
          config.onSwipeRight()
        } else if (dx < 0 && config.onSwipeLeft) {
          config.onSwipeLeft()
        }
        // Reset after action
        content.style.transition = 'none'
        content.style.transform = ''
        content.style.opacity = ''
        container.style.backgroundColor = ''
        resetIcons()
        requestAnimationFrame(() => {
          content.style.transition = ''
        })
      }, 200)
    } else {
      // Snap back
      content.style.transition = 'transform 150ms ease-out'
      content.style.transform = ''
      container.style.backgroundColor = ''
      resetIcons()
      setTimeout(() => {
        content.style.transition = ''
      }, 150)
    }

    state.current = { ...s, swiping: false, direction: null }
  }, [contentRef, containerRef, threshold, config])

  return { onTouchStart, onTouchMove, onTouchEnd }
}
