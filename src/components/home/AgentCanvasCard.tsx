import { useEffect, useRef, useState } from 'react'
import { Trash2, Maximize2, Minimize2, ExternalLink } from 'lucide-react'
import { useDashboardStore } from '@/store/dashboard'
import { getHubUrl } from '@/hub'
import { showConfirm } from '@/dialog'

export function AgentCanvasCard() {
  const reloadKey = useDashboardStore((s) => s.canvasReloadKey)
  const meta = useDashboardStore((s) => s.canvasMeta)
  const refreshMeta = useDashboardStore((s) => s.refreshCanvasMeta)
  const clearCanvas = useDashboardStore((s) => s.clearCanvas)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [maximized, setMaximized] = useState(false)

  // Reload iframe when the canvas dir changes (fired off WS event by the hub).
  useEffect(() => {
    if (reloadKey === 0) return
    const iframe = iframeRef.current
    if (!iframe) return
    try { iframe.contentWindow?.location.reload() } catch {
      // Cross-origin iframe (sandboxed) — fall back to bumping src with a cache buster.
      iframe.src = canvasSrc(reloadKey)
    }
  }, [reloadKey])

  useEffect(() => { void refreshMeta() }, [refreshMeta])

  // Esc exits fullscreen
  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])

  const onClear = async () => {
    if (!(await showConfirm('Clear the canvas?', { title: 'Clear canvas', danger: true, confirmLabel: 'Clear' }))) return
    await clearCanvas()
  }

  const openInNewTab = () => window.open(`${getHubUrl()}/canvas/index.html`, '_blank', 'noopener,noreferrer')

  return (
    <section
      className={
        maximized
          ? 'fixed inset-0 z-50 flex flex-col border-0 rounded-none bg-surface-1 overflow-hidden'
          : 'flex flex-col min-h-0 h-full border border-border rounded-sm bg-surface-1 overflow-hidden'
      }
    >
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">Agent canvas</h2>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-text-tertiary">
            {meta?.isPlaceholder ? 'empty' : meta ? `updated ${fmtAgo(Date.now() - meta.updatedAt)}` : ''}
          </span>
          <button
            onClick={openInNewTab}
            className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors duration-fast"
            title="Open canvas in a new browser tab"
          >
            <ExternalLink size={11} />
          </button>
          <button
            onClick={() => setMaximized(!maximized)}
            className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors duration-fast"
            title={maximized ? 'Restore (Esc)' : 'Maximize'}
          >
            {maximized ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
          <button
            onClick={onClear}
            disabled={meta?.isPlaceholder}
            className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors duration-fast disabled:opacity-30 disabled:hover:text-text-tertiary"
            title="Wipe canvas back to placeholder"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </header>
      <iframe
        ref={iframeRef}
        src={canvasSrc(0)}
        sandbox="allow-scripts"
        title="AI agent canvas"
        className="flex-1 min-h-0 w-full border-0 bg-surface-0"
      />
    </section>
  )
}

function canvasSrc(bust: number): string {
  // The iframe loads the hub's static canvas file directly. Sandbox is
  // "allow-scripts" only — null origin, no cookies, no parent access.
  const u = `${getHubUrl()}/canvas/index.html`
  return bust ? `${u}?_=${bust}` : u
}

function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
