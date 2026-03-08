import { useRef, useCallback, type RefObject } from 'react'

interface SwipeConfig {
  onSwipeRight?: () => void
  onSwipeLeft?: () => void
  onSwipeStart?: () => void
  onSwipeEnd?: () => void
  threshold?: number
}

interface SwipeState {
  startX: number
  startY: number
  currentX: number
  swiping: boolean
  direction: 'horizontal' | 'vertical' | null
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
  })

  const threshold = config.threshold ?? 120

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]!
    state.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      swiping: false,
      direction: null,
    }
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]!
    const s = state.current
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
    } else {
      container.style.backgroundColor = `rgba(245, 158, 11, ${progress * 0.3})`
    }
  }, [contentRef, containerRef, threshold, config])

  const onTouchEnd = useCallback(() => {
    const s = state.current
    const content = contentRef.current
    const container = containerRef.current

    config.onSwipeEnd?.()

    if (!s.swiping || !content || !container) {
      if (content) {
        content.style.transform = ''
        content.style.transition = ''
      }
      if (container) container.style.backgroundColor = ''
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
        requestAnimationFrame(() => {
          content.style.transition = ''
        })
      }, 200)
    } else {
      // Snap back
      content.style.transition = 'transform 150ms ease-out'
      content.style.transform = ''
      container.style.backgroundColor = ''
      setTimeout(() => {
        content.style.transition = ''
      }, 150)
    }

    state.current = { ...s, swiping: false, direction: null }
  }, [contentRef, containerRef, threshold, config])

  return { onTouchStart, onTouchMove, onTouchEnd }
}
