import { useCallback, useEffect, useMemo, useRef } from 'react'
import { select, pointer } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { useAgentStore } from '@/store/agent'
import { buildOrgLayout, hitTest, subtreeKeys, NODE_W, NODE_H, type OrgLayout } from './agent-orgchart-helpers'

// Visual org chart: a top-down node-link tree on a canvas. Pan/zoom via d3-zoom;
// click a node to open it; drag a node onto another to reparent (drop on empty
// space = make it a root). Mirrors the Notes circles-view engine, tree layout.

interface NodeStatus { live: boolean; status?: 'running' | 'idle' | 'ended'; unread?: boolean; attention?: boolean; active?: boolean }

export function AgentOrgChart({ onPick }: { onPick: (roleKey: string) => void }) {
  const agentTree = useAgentStore((s) => s.agentTree)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const setAgentManager = useAgentStore((s) => s.setAgentManager)

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const transformRef = useRef<ZoomTransform>(zoomIdentity)
  const fittedRef = useRef(false)
  const dragRef = useRef<{ key: string; subtree: Set<string>; moved: boolean; dropKey: string | null } | null>(null)

  const layout = useMemo(() => buildOrgLayout(agentTree), [agentTree])
  const layoutRef = useRef<OrgLayout>(layout)
  layoutRef.current = layout

  const statusByKey = useMemo(() => {
    const m = new Map<string, NodeStatus>()
    for (const s of sessions) {
      if (!s.agentKey || s.status === 'ended') continue
      m.set(s.agentKey, {
        live: true,
        status: s.status,
        unread: !!s.hasUnread,
        attention: !!s.needsAttention,
        active: s.id === activeSessionId,
      })
    }
    return m
  }, [sessions, activeSessionId])
  const statusRef = useRef(statusByKey)
  statusRef.current = statusByKey

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const W = container.clientWidth
    const H = container.clientHeight
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr
      canvas.height = H * dpr
    }
    const t = transformRef.current
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, W, H)
    ctx.translate(t.x, t.y)
    ctx.scale(t.k, t.k)

    const { nodes, edges } = layoutRef.current

    // edges
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 1.5
    for (const e of edges) {
      const midY = (e.y1 + e.y2) / 2
      ctx.beginPath()
      ctx.moveTo(e.x1, e.y1)
      ctx.bezierCurveTo(e.x1, midY, e.x2, midY, e.x2, e.y2)
      ctx.stroke()
    }

    // nodes
    const drag = dragRef.current
    ctx.font = '500 13px ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    for (const n of nodes) {
      const st = statusRef.current.get(n.key)
      const x = n.x - NODE_W / 2
      const y = n.y - NODE_H / 2
      const isDropTarget = drag?.dropKey === n.key
      const isDragging = drag?.key === n.key
      // box
      ctx.beginPath()
      roundRect(ctx, x, y, NODE_W, NODE_H, 8)
      ctx.fillStyle = st?.active ? '#1e293b' : '#141414'
      ctx.globalAlpha = isDragging ? 0.5 : 1
      ctx.fill()
      ctx.lineWidth = isDropTarget ? 2.5 : 1.5
      ctx.strokeStyle = isDropTarget ? '#3b82f6'
        : n.danglingManager || n.cycleBroken ? '#f59e0b'
        : st?.active ? '#3b82f6'
        : st?.live ? '#3f3f46' : '#262626'
      if (!st?.live) ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])

      // status dot
      const dotColor = !st?.live ? '#52525b'
        : st.attention ? '#ef4444'
        : st.status === 'running' ? '#f59e0b'
        : st.unread ? '#3b82f6'
        : '#22c55e'
      ctx.beginPath()
      ctx.arc(x + 13, n.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = dotColor
      ctx.fill()

      // title
      ctx.fillStyle = st?.live ? '#e5e5e5' : '#a1a1aa'
      ctx.fillText(fit(ctx, n.title, NODE_W - 34), x + 24, n.y - (st?.live ? 0 : 0))
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }, [])

  // Fit the tree into view once it's laid out.
  useEffect(() => {
    const container = containerRef.current
    if (!container || layout.nodes.length === 0) return
    if (fittedRef.current && layout.nodes.length) { draw(); return }
    const W = container.clientWidth || 800
    const k = Math.min(1, (W - 40) / Math.max(layout.width, 1))
    transformRef.current = zoomIdentity.translate((W - layout.width * k) / 2, 20).scale(k)
    fittedRef.current = true
    draw()
  }, [layout, draw])

  // d3-zoom for pan/wheel/pinch. Reject pointer gestures that START on a node so
  // the node-drag handler owns them (mirrors circles-view's filter hit-test).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const sel = select<HTMLCanvasElement, unknown>(canvas)
    const zoomB: ZoomBehavior<HTMLCanvasElement, unknown> = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.25, 2.5])
      .filter((event: Event) => {
        if (event.type === 'wheel') return true
        const [px, py] = pointer(event, canvas)
        const w = transformRef.current.invert([px, py])
        return hitTest(layoutRef.current.nodes, w[0], w[1]) === null
      })
      .on('zoom', (e: { transform: ZoomTransform }) => { transformRef.current = e.transform; draw() })
    sel.call(zoomB)
    return () => { sel.on('.zoom', null) }
  }, [draw])

  // Node drag (reparent) + click (open). Fires only for pointerdowns d3-zoom's
  // filter rejected (i.e. those that landed on a node).
  const worldAt = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return transformRef.current.invert([e.clientX - rect.left, e.clientY - rect.top])
  }
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const [wx, wy] = worldAt(e)
    const hit = hitTest(layoutRef.current.nodes, wx, wy)
    if (!hit) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { key: hit.key, subtree: subtreeKeys(layoutRef.current.nodes, hit.key), moved: false, dropKey: null }
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const [wx, wy] = worldAt(e)
    drag.moved = true
    const target = hitTest(layoutRef.current.nodes, wx, wy, drag.subtree)
    drag.dropKey = target?.key ?? null
    draw()
  }, [draw])
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    try { canvasRef.current?.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    if (!drag) return
    if (!drag.moved) { onPick(drag.key); return }
    const [wx, wy] = worldAt(e)
    const target = hitTest(layoutRef.current.nodes, wx, wy, drag.subtree)
    // Drop on a node → reparent under it; drop on empty space → make it a root.
    setAgentManager(drag.key, target?.key ?? null)
    draw()
  }, [onPick, setAgentManager, draw])

  if (layout.nodes.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-text-tertiary">No agent roles yet</div>
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        style={{ width: '100%', height: '100%' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-text-tertiary">
        drag a node onto another to reparent · drop on empty space to make it a root · click to open
      </div>
    </div>
  )
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}
