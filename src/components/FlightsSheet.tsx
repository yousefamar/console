// FlightsSheet — full-screen mobile overlay wrapping the flights panel.
//
// Triggered from CalendarMobileControls. The desktop sidebar mounts
// FlightsPanel directly; mobile mounts this sheet on top of the calendar grid
// because the desktop sidebar is hidden at phone widths.

import { useEffect } from 'react'
import { Plane, X } from 'lucide-react'
import { useFlightsStore } from '@/store/flights'
import { FlightsPanel } from './FlightsPanel'

export function FlightsSheet() {
  const open = useFlightsStore((s) => s.sheetOpen)
  const setOpen = useFlightsStore((s) => s.setSheetOpen)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[55] flex flex-col bg-surface-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-1">
        <Plane size={16} className="text-text-secondary" />
        <span className="text-sm font-medium text-text-primary flex-1">Flight watchlists</span>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="p-1.5 text-text-secondary hover:text-text-primary"
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <FlightsPanel compact={false} />
      </div>
    </div>
  )
}
