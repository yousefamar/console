import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface ImageLightboxProps {
  src: string
  onClose: () => void
  /** Optional gallery navigation — when provided, ←/→ page through images
   *  and on-screen chevrons render. */
  onPrev?: () => void
  onNext?: () => void
  /** 1-based position + total for the counter chip. */
  position?: { index: number; total: number }
}

const MIN_SCALE = 1
const MAX_SCALE = 8

export function ImageLightbox({ src, onClose, onPrev, onNext, position }: ImageLightboxProps) {
  // Zoom/pan transform: translate(tx,ty) scale(s), origin center.
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const imgRef = useRef<HTMLImageElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Active pointers for drag-pan (1) and pinch-zoom (2).
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<{ dist: number; s: number } | null>(null)
  const dragged = useRef(false)

  useEffect(() => { setT({ s: 1, x: 0, y: 0 }) }, [src])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Capture phase + stopPropagation: the app's global keydown handler
      // (useKeybindings) treats Escape as "deselect room" and arrows as list
      // nav. While the lightbox is up it owns these keys exclusively —
      // otherwise one Esc closes both the image AND the chat behind it.
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowLeft' && onPrev) {
        e.preventDefault()
        e.stopPropagation()
        onPrev()
      } else if (e.key === 'ArrowRight' && onNext) {
        e.preventDefault()
        e.stopPropagation()
        onNext()
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [onClose, onPrev, onNext])

  /** Zoom about a viewport point so the pixel under the cursor stays put. */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setT((cur) => {
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cur.s * factor))
      if (s === cur.s) return cur
      if (s === MIN_SCALE) return { s: 1, x: 0, y: 0 }
      const rect = wrapRef.current?.getBoundingClientRect()
      const ox = rect ? cx - (rect.left + rect.width / 2) : 0
      const oy = rect ? cy - (rect.top + rect.height / 2) : 0
      const ratio = s / cur.s
      return { s, x: ox - ratio * (ox - cur.x), y: oy - ratio * (oy - cur.y) }
    })
  }, [])

  // Wheel zoom — native non-passive listener so preventDefault sticks.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    dragged.current = false
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchStart.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), s: t.s }
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }, [t.s])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      const target = pinchStart.current.s * (dist / pinchStart.current.dist)
      const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }
      setT((cur) => {
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, target))
        if (s === MIN_SCALE) return { s: 1, x: 0, y: 0 }
        const rect = wrapRef.current?.getBoundingClientRect()
        const ox = rect ? mid.x - (rect.left + rect.width / 2) : 0
        const oy = rect ? mid.y - (rect.top + rect.height / 2) : 0
        const ratio = s / cur.s
        return { s, x: ox - ratio * (ox - cur.x), y: oy - ratio * (oy - cur.y) }
      })
      dragged.current = true
    } else if (pointers.current.size === 1) {
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged.current = true
      setT((cur) => (cur.s > 1 ? { ...cur, x: cur.x + dx, y: cur.y + dy } : cur))
    }
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null
  }, [])

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (t.s > 1) setT({ s: 1, x: 0, y: 0 })
    else zoomAt(2.5, e.clientX, e.clientY)
  }, [t.s, zoomAt])

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out overflow-hidden touch-none"
      onClick={onClose}
    >
      {onPrev && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev() }}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 p-2 text-white/70 hover:text-white"
          title="Previous (←)"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      <img
        ref={imgRef}
        src={src}
        alt=""
        draggable={false}
        className="max-h-[90vh] max-w-[90vw] object-contain select-none"
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`,
          cursor: t.s > 1 ? 'grab' : 'zoom-in',
          transition: pointers.current.size ? 'none' : 'transform 120ms ease-out',
        }}
        onClick={(e) => { e.stopPropagation(); if (dragged.current) { dragged.current = false } }}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {onNext && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext() }}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 p-2 text-white/70 hover:text-white"
          title="Next (→)"
        >
          <ChevronRight size={22} />
        </button>
      )}
      {position && position.total > 1 && (
        <span
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 text-xs text-white/80 tabular-nums"
          onClick={(e) => e.stopPropagation()}
        >
          {position.index} / {position.total}
        </span>
      )}
    </div>
  )
}
