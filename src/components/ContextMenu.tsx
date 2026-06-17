import { useEffect, useRef, useState, useCallback } from 'react'
import { useIsMobile } from '@/hooks/useMediaQuery'

// ============================================================================
// ContextMenu — dropdown menu triggered by right-click (desktop) or
// long-press (mobile). Renders at cursor/touch position.
// ============================================================================

export interface ContextMenuItem {
  label: string
  onClick: () => void
  destructive?: boolean
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  children: React.ReactNode
  className?: string
}

export function ContextMenu({ items, children, className }: ContextMenuProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Touch start position — used to cancel the long-press timer if the finger
   *  moves enough to look like a swipe instead of a deliberate hold. */
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)

  // Right-click
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (items.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    setPos({ x: e.clientX, y: e.clientY })
    setOpen(true)
  }, [items.length])

  // Long-press
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (items.length === 0) return
    const touch = e.touches[0]!
    touchStartPos.current = { x: touch.clientX, y: touch.clientY }
    longPressTimer.current = setTimeout(() => {
      setPos({ x: touch.clientX, y: touch.clientY })
      setOpen(true)
    }, 500)
  }, [items.length])

  // If the finger moves > ~10px before the 500 ms long-press timer fires, the
  // user is swiping (matches the swipe hook's direction threshold). Cancel the
  // timer so the context menu doesn't pop up mid-swipe.
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!longPressTimer.current || !touchStartPos.current) return
    const touch = e.touches[0]!
    const dx = touch.clientX - touchStartPos.current.x
    const dy = touch.clientY - touchStartPos.current.y
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    touchStartPos.current = null
  }, [])

  return (
    <>
      <div
        onContextMenu={handleContextMenu}
        onTouchStart={isMobile ? handleTouchStart : undefined}
        onTouchMove={isMobile ? handleTouchMove : undefined}
        onTouchEnd={isMobile ? handleTouchEnd : undefined}
        onTouchCancel={isMobile ? handleTouchEnd : undefined}
        className={className}
      >
        {children}
      </div>

      {open && <ContextMenuView items={items} x={pos.x} y={pos.y} onClose={() => setOpen(false)} />}
    </>
  )
}

// --------------------------------------------------------------------------
// Controlled variant — render at an arbitrary point with explicit open/close.
// Used where the trigger isn't a wrapped element (e.g. a <canvas> node, which
// hit-tests the pointer and opens this directly).
// --------------------------------------------------------------------------

export function ContextMenuView({ items, x, y, onClose }: {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useEffect(() => setPos({ x, y }), [x, y])

  // Close on outside click or scroll
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  // Clamp position to viewport
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 4 : x
    const ny = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 4 : y
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  if (items.length === 0) return null
  return (
    <div
      ref={menuRef}
      className="fixed z-50 border border-border bg-surface-1 shadow-lg py-0.5 min-w-[150px]"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => { onClose(); item.onClick() }}
          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 transition-colors duration-fast ${
            item.destructive ? 'text-destructive' : 'text-text-secondary'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
