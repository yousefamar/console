import { useEffect } from 'react'
import { X, Download } from 'lucide-react'

interface PdfLightboxProps {
  src: string
  filename?: string
  onClose: () => void
}

// PDFs render in the browser's built-in viewer when handed to <iframe>. Works
// in Chromium (desktop + Android WebView) and Safari. Server-side rendering
// or PDF.js would be heavier without buying us anything for these use cases.
export function PdfLightbox({ src, filename, onClose }: PdfLightboxProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-sm">{filename ?? 'document.pdf'}</span>
        <div className="flex items-center gap-1">
          <a
            href={src}
            download={filename ?? 'document.pdf'}
            className="rounded-sm p-1 hover:bg-white/10"
            title="Download"
          >
            <Download size={16} />
          </a>
          <button
            onClick={onClose}
            className="rounded-sm p-1 hover:bg-white/10"
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <iframe
        src={src}
        className="flex-1 w-full bg-white"
        title={filename ?? 'PDF'}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
