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
  const menuRef = useRef<HTMLDivElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    longPressTimer.current = setTimeout(() => {
      setPos({ x: touch.clientX, y: touch.clientY })
      setOpen(true)
    }, 500)
  }, [items.length])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  // Close on outside click or scroll
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('scroll', close, true)
    }
  }, [open])

  // Clamp position to viewport
  useEffect(() => {
    if (!open || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let { x, y } = pos
    if (x + rect.width > vw) x = vw - rect.width - 4
    if (y + rect.height > vh) y = vh - rect.height - 4
    if (x !== pos.x || y !== pos.y) setPos({ x, y })
  }, [open])

  return (
    <>
      <div
        onContextMenu={handleContextMenu}
        onTouchStart={isMobile ? handleTouchStart : undefined}
        onTouchEnd={isMobile ? handleTouchEnd : undefined}
        onTouchCancel={isMobile ? handleTouchEnd : undefined}
        className={className}
      >
        {children}
      </div>

      {open && (
        <div
          ref={menuRef}
          className="fixed z-50 border border-border bg-surface-1 shadow-lg py-0.5 min-w-[140px]"
          style={{ left: pos.x, top: pos.y }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => { setOpen(false); item.onClick() }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 transition-colors duration-fast ${
                item.destructive ? 'text-destructive' : 'text-text-secondary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
