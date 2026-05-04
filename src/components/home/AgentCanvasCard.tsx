import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import { useDashboardStore } from '@/store/dashboard'
import { getHubUrl } from '@/hub'
import { showConfirm } from '@/dialog'

export function AgentCanvasCard() {
  const reloadKey = useDashboardStore((s) => s.canvasReloadKey)
  const meta = useDashboardStore((s) => s.canvasMeta)
  const refreshMeta = useDashboardStore((s) => s.refreshCanvasMeta)
  const clearCanvas = useDashboardStore((s) => s.clearCanvas)
  const iframeRef = useRef<HTMLIFrameElement>(null)

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

  const onClear = async () => {
    if (!(await showConfirm('Clear the canvas?', { title: 'Clear canvas', danger: true, confirmLabel: 'Clear' }))) return
    await clearCanvas()
  }

  return (
    <section className="flex flex-col min-h-0 h-full border border-border rounded-sm bg-surface-1 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">Agent canvas</h2>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-text-tertiary">
            {meta?.isPlaceholder ? 'empty' : meta ? `updated ${fmtAgo(Date.now() - meta.updatedAt)}` : ''}
          </span>
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
