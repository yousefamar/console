import { useEffect } from 'react'
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

export function ImageLightbox({ src, onClose, onPrev, onNext, position }: ImageLightboxProps) {
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
      onClick={onClose}
    >
      {onPrev && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev() }}
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/70 hover:text-white"
          title="Previous (←)"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      <img
        src={src}
        alt=""
        className="max-h-[90vh] max-w-[90vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      {onNext && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext() }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white/70 hover:text-white"
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
