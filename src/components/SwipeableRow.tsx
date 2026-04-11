import { useRef, useCallback, type ReactNode } from 'react'

interface SwipeAction {
  icon: ReactNode
  color: string // CSS rgba base color, e.g. '34, 197, 94'
  onTrigger: () => void
}

interface SwipeableRowProps {
  children: ReactNode
  left?: SwipeAction   // swipe-left action (content moves left, icon appears on right)
  right?: SwipeAction  // swipe-right action (content moves right, icon appears on left)
  threshold?: number
}

interface SwipeState {
  startX: number
  startY: number
  currentX: number
  swiping: boolean
  direction: 'horizontal' | 'vertical' | null
}

export function SwipeableRow({ children, left, right, threshold = 100 }: SwipeableRowProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const leftIconRef = useRef<HTMLDivElement>(null)
  const rightIconRef = useRef<HTMLDivElement>(null)
  const state = useRef<SwipeState>({
    startX: 0, startY: 0, currentX: 0, swiping: false, direction: null,
  })

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]!
    state.current = {
      startX: touch.clientX, startY: touch.clientY,
      currentX: touch.clientX, swiping: false, direction: null,
    }
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]!
    const s = state.current
    const dx = touch.clientX - s.startX
    const dy = touch.clientY - s.startY

    if (!s.direction) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        s.direction = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      }
    }
    if (s.direction !== 'horizontal') return

    // Block swipe if no action configured for this direction
    if (dx > 0 && !right) return
    if (dx < 0 && !left) return

    e.preventDefault()
    s.swiping = true
    s.currentX = touch.clientX

    const content = contentRef.current
    const container = containerRef.current
    if (!content || !container) return

    const progress = Math.min(Math.abs(dx) / threshold, 1)
    content.style.transform = `translateX(${dx}px)`
    content.style.transition = 'none'

    if (dx > 0 && right) {
      container.style.backgroundColor = `rgba(${right.color}, ${progress * 0.3})`
      if (leftIconRef.current) {
        leftIconRef.current.style.opacity = `${progress}`
      }
    } else if (dx < 0 && left) {
      container.style.backgroundColor = `rgba(${left.color}, ${progress * 0.3})`
      if (rightIconRef.current) {
        rightIconRef.current.style.opacity = `${progress}`
      }
    }
  }, [left, right, threshold])

  const onTouchEnd = useCallback(() => {
    const s = state.current
    const content = contentRef.current
    const container = containerRef.current

    const reset = () => {
      if (content) { content.style.transform = ''; content.style.transition = '' }
      if (container) container.style.backgroundColor = ''
      if (leftIconRef.current) leftIconRef.current.style.opacity = '0'
      if (rightIconRef.current) rightIconRef.current.style.opacity = '0'
    }

    if (!s.swiping || !content || !container) {
      reset()
      return
    }

    const dx = s.currentX - s.startX
    const pastThreshold = Math.abs(dx) > threshold

    if (pastThreshold) {
      const direction = dx > 0 ? 1 : -1
      content.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out'
      content.style.transform = `translateX(${direction * window.innerWidth}px)`
      content.style.opacity = '0'

      setTimeout(() => {
        if (dx > 0 && right) right.onTrigger()
        else if (dx < 0 && left) left.onTrigger()
        content.style.transition = 'none'
        content.style.transform = ''
        content.style.opacity = ''
        reset()
        requestAnimationFrame(() => { content.style.transition = '' })
      }, 200)
    } else {
      content.style.transition = 'transform 150ms ease-out'
      content.style.transform = ''
      setTimeout(() => { content.style.transition = ''; reset() }, 150)
    }

    state.current = { ...s, swiping: false, direction: null }
  }, [left, right, threshold])

  return (
    <div ref={containerRef} className="relative overflow-hidden">
      {/* Left icon (shown when swiping right) */}
      {right && (
        <div
          ref={leftIconRef}
          className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none"
          style={{ opacity: 0 }}
        >
          {right.icon}
        </div>
      )}
      {/* Right icon (shown when swiping left) */}
      {left && (
        <div
          ref={rightIconRef}
          className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none"
          style={{ opacity: 0 }}
        >
          {left.icon}
        </div>
      )}
      <div
        ref={contentRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {children}
      </div>
    </div>
  )
}
