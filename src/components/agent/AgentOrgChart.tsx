import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Minimize2, Maximize2, FolderPlus } from 'lucide-react'
import { select, pointer } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { useAgentStore } from '@/store/agent'
import { useCronStore } from '@/store/cron'
import { showPrompt, showConfirm } from '@/dialog'
import { ContextMenuView, type ContextMenuItem } from '../ContextMenu'
import { buildOrgLayout, hitTest, hitToggle, subtreeKeys, NODE_W, NODE_H, TOGGLE_R, type OrgLayout } from './agent-orgchart-helpers'

// Pointer must travel this many screen px before a press becomes a drag. Below
// it, the gesture is a click — stops a slightly-shaky click from reparenting.
const DRAG_THRESHOLD = 6

// Visual org chart: an animated left-to-right node-link tree on a canvas.
// Pan/zoom via d3-zoom; click a node to open it; drag a node onto another to
// reparent (drop on empty space = root); ＋/－ to collapse. Node positions are
// lerped each frame so reparents/collapses slide rather than jump.

interface NodeStatus { live: boolean; status?: 'running' | 'idle' | 'ended'; unread?: boolean; attention?: boolean; active?: boolean; bg: number; cron: number }
interface XY { x: number; y: number }

export function AgentOrgChart({ onPick }: { onPick: (roleKey: string) => void }) {
  const agentRoles = useAgentStore((s) => s.agentRoles)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const setAgentManager = useAgentStore((s) => s.setAgentManager)
  const createFolder = useAgentStore((s) => s.createFolder)
  const filterAlerted = useAgentStore((s) => s.filterAlerted)
  const pendingApprovals = useAgentStore((s) => s.pendingApprovalsBySession)
  const forkSession = useAgentStore((s) => s.forkSession)
  const reviveAgent = useAgentStore((s) => s.reviveAgent)
  const reloadSession = useAgentStore((s) => s.reloadSession)
  const reloadSessionHistory = useAgentStore((s) => s.reloadSessionHistory)
  const killSession = useAgentStore((s) => s.killSession)
  const deleteRole = useAgentStore((s) => s.deleteRole)
  const renameRole = useAgentStore((s) => s.renameRole)
  const openRoleInfo = useAgentStore((s) => s.openRoleInfo)
  const delegate = useAgentStore((s) => s.delegate)
  const tasks = useAgentStore((s) => s.tasks)
  const cronTasks = useCronStore((s) => s.tasksBySession)

  // Right-click / long-press context menu (screen coords + role key).
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const transformRef = useRef<ZoomTransform>(zoomIdentity)
  const zoomBRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const fittedRef = useRef(false)
  const posRef = useRef<Map<string, XY>>(new Map())     // animated positions
  const rafRef = useRef<number | null>(null)
  const hoverRef = useRef<string | null>(null)
  const panningRef = useRef(false)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragRef = useRef<{ key: string; kind: 'al' | 'role' | 'group'; subtree: Set<string>; moved: boolean; dropKey: string | null; cursor: XY; start: { x: number; y: number } } | null>(null)

  // Collapsed node keys — device-local, persisted. Pruned subtrees + a +N badge.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('console:agents:orgCollapsed') || '[]')) } catch { return new Set() }
  })
  const persistCollapsed = (next: Set<string>) => {
    try { localStorage.setItem('console:agents:orgCollapsed', JSON.stringify([...next])) } catch { /* ignore */ }
    setCollapsed(next)
  }
  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      try { localStorage.setItem('console:agents:orgCollapsed', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [])

  // Keys of roles whose live session "needs me" — drives the focus filter.
  const alertedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const s of sessions) {
      if (!s.agentKey || s.status === 'ended') continue
      if (s.hasUnread || s.needsAttention || pendingApprovals[s.id] || s.status === 'running') keys.add(s.agentKey)
    }
    return keys
  }, [sessions, pendingApprovals])

  // When filtering, ignore manual collapse and prune to the alerted subtree.
  const layout = useMemo(
    () => buildOrgLayout(agentRoles, filterAlerted ? new Set<string>() : collapsed, filterAlerted ? alertedKeys : null),
    [agentRoles, collapsed, filterAlerted, alertedKeys],
  )
  const layoutRef = useRef<OrgLayout>(layout)
  layoutRef.current = layout
  const collapsibleKeys = useMemo(
    () => buildOrgLayout(agentRoles).nodes.filter((n) => n.hasChildren && n.key !== 'al').map((n) => n.key),
    [agentRoles],
  )

  const statusByKey = useMemo(() => {
    const m = new Map<string, NodeStatus>()
    for (const s of sessions) {
      if (!s.agentKey || s.status === 'ended') continue
      const csid = s.claudeSessionId
      const cron = csid ? (cronTasks[csid] ?? []).filter((t) => !t.disabledAt).length : 0
      m.set(s.agentKey, {
        live: true, status: s.status, unread: !!s.hasUnread, attention: !!s.needsAttention,
        active: s.id === activeSessionId, bg: s.backgroundProcessCount ?? 0, cron,
      })
    }
    return m
  }, [sessions, activeSessionId, cronTasks])
  const statusRef = useRef(statusByKey)
  statusRef.current = statusByKey

  // Open delegated-task count per assignee role → a node badge.
  const taskCountByKey = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tasks) {
      if (t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked') {
        m.set(t.toKey, (m.get(t.toKey) ?? 0) + 1)
      }
    }
    return m
  }, [tasks])
  const taskRef = useRef(taskCountByKey)
  taskRef.current = taskCountByKey

  // Org edges currently carrying an active delegation → drawn yellow + animated
  // dashes. Built from each open task's chain (consecutive manager→report hops).
  const activeEdges = useMemo(() => {
    const s = new Set<string>()
    for (const t of tasks) {
      if (t.status !== 'pending' && t.status !== 'in_progress') continue
      for (let i = 0; i < t.chain.length - 1; i++) s.add(`${t.chain[i]}>${t.chain[i + 1]}`)
    }
    return s
  }, [tasks])
  const activeEdgesRef = useRef(activeEdges)
  activeEdgesRef.current = activeEdges
  const dashOffsetRef = useRef(0)

  // --- rendering -----------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const W = container.clientWidth
    const H = container.clientHeight
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr }
    const t = transformRef.current
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0a0a0a'
    ctx.fillRect(0, 0, W, H)
    ctx.translate(t.x, t.y)
    ctx.scale(t.k, t.k)

    const { nodes } = layoutRef.current
    const pos = posRef.current
    const drag = dragRef.current
    const ghostKey = drag?.moved && drag.kind !== 'al' ? drag.key : null
    const target = new Map(nodes.map((n) => [n.key, n]))
    const P = (k: string): XY | null => {
      if (k === ghostKey && drag) return drag.cursor
      const p = pos.get(k)
      if (p) return p
      const tn = target.get(k)
      return tn ? { x: tn.x, y: tn.y } : null
    }

    // edges — active delegations highlighted yellow + marching dashes
    for (const n of nodes) {
      if (!n.parentKey) continue
      const p = P(n.parentKey), c = P(n.key)
      if (!p || !c) continue
      const x1 = p.x + NODE_W / 2, y1 = p.y, x2 = c.x - NODE_W / 2, y2 = c.y, midX = (x1 + x2) / 2
      const isActive = activeEdgesRef.current.has(`${n.parentKey}>${n.key}`)
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.bezierCurveTo(midX, y1, midX, y2, x2, y2)
      if (isActive) {
        ctx.strokeStyle = '#eab308'; ctx.lineWidth = 2
        ctx.setLineDash([6, 4]); ctx.lineDashOffset = -dashOffsetRef.current
      } else {
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      }
      ctx.stroke()
    }
    ctx.setLineDash([])

    ctx.textBaseline = 'middle'
    const drawNode = (n: typeof nodes[number], cx: number, cy: number, ghost: boolean) => {
      const x = cx - NODE_W / 2, y = cy - NODE_H / 2
      const isDropTarget = drag?.dropKey === n.key
      const isHover = !drag && hoverRef.current === n.key
      if (ghost) { ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 7 }

      if (n.kind === 'group') {
        ctx.beginPath(); roundRect(ctx, x, y, NODE_W, NODE_H, 8)
        ctx.fillStyle = isHover ? '#15151a' : '#0f0f12'; ctx.fill()
        ctx.lineWidth = 1.5; ctx.strokeStyle = isHover ? '#52525b' : '#3f3f46'
        ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([])
        ctx.fillStyle = '#71717a'
        ctx.beginPath(); roundRect(ctx, x + 12, cy - 6, 14, 11, 2); ctx.fill()
        ctx.fillRect(x + 12, cy - 8, 7, 3)
        ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'
        ctx.fillStyle = '#a1a1aa'
        ctx.fillText(fit(ctx, n.title, NODE_W - 60) + (n.childCount ? `  ·${n.childCount}` : ''), x + 34, cy)
      } else {
        const st = statusRef.current.get(n.key)
        const isFork = /\(fork\)\s*$/i.test(n.title)
        const display = isFork ? n.title.replace(/\s*\(fork\)\s*$/i, '') : n.title
        ctx.beginPath(); roundRect(ctx, x, y, NODE_W, NODE_H, 8)
        ctx.fillStyle = st?.active ? '#1e293b' : isFork ? '#17141f' : isHover ? '#1b1b1e' : '#141414'
        if (!ghost && drag?.key === n.key) ctx.globalAlpha = 0.35 // faded origin while dragging
        ctx.fill()
        ctx.lineWidth = isDropTarget ? 2.5 : 1.5
        ctx.strokeStyle = isDropTarget ? '#3b82f6'
          : n.danglingManager || n.cycleBroken ? '#f59e0b'
          : isFork ? '#8b5cf6'
          : st?.active ? '#3b82f6'
          : isHover ? '#52525b'
          : st?.live ? '#3f3f46' : '#262626'
        if (!st?.live) ctx.setLineDash([4, 3])
        ctx.stroke(); ctx.setLineDash([])

        // (Forks are already distinguished by the violet border + italic violet
        // title — no corner dog-ear needed.)

        // Dot only for noteworthy live states — no green "idle/ok" dot (the
        // absence of a dot means "fine"). Attention > running > unread.
        const dotColor = st?.live
          ? (st.attention ? '#ef4444' : st.status === 'running' ? '#f59e0b' : st.unread ? '#3b82f6' : null)
          : null
        const taskN = taskRef.current.get(n.key) ?? 0
        const hasBadges = (!!st && (st.bg > 0 || st.cron > 0)) || taskN > 0
        if (dotColor) {
          ctx.beginPath(); ctx.arc(x + 13, cy - (hasBadges ? 6 : 0), 4, 0, Math.PI * 2)
          ctx.fillStyle = dotColor; ctx.fill()
        }
        const titleX = dotColor ? x + 24 : x + 13

        // title (nudged up when there's a badge row)
        ctx.font = `${isFork ? 'italic ' : ''}500 13px ui-sans-serif, system-ui, sans-serif`
        ctx.fillStyle = isFork ? '#c4b5fd' : st?.live ? '#e5e5e5' : '#a1a1aa'
        ctx.fillText(fit(ctx, display, NODE_W - (dotColor ? 34 : 22)), titleX, hasBadges ? cy - 6 : cy)

        // task + cron + shell badges (bottom-left, mirrors the sidebar list)
        if (hasBadges) {
          let bx = titleX
          ctx.textBaseline = 'middle'
          if (taskN > 0) { bx = drawBadge(ctx, bx, cy + 11, '#a78bfa', 'task', taskN) }
          if (st && st.bg > 0) { bx = drawBadge(ctx, bx, cy + 11, '#f59e0b', 'shell', st.bg) }
          if (st && st.cron > 0) { bx = drawBadge(ctx, bx, cy + 11, '#60a5fa', 'cron', st.cron) }
          ctx.textBaseline = 'middle'
        }
      }
      ctx.globalAlpha = 1

      if (n.hasChildren) {
        const tx = cx + NODE_W / 2
        ctx.beginPath(); ctx.arc(tx, cy, TOGGLE_R, 0, Math.PI * 2)
        ctx.fillStyle = '#09090b'; ctx.fill()
        ctx.lineWidth = 1.5; ctx.strokeStyle = n.collapsed ? '#6366f1' : '#52525b'; ctx.stroke()
        ctx.fillStyle = n.collapsed ? '#a5b4fc' : '#a1a1aa'
        ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center'
        ctx.fillText(n.collapsed ? '+' : '–', tx, cy + 1)
        ctx.textAlign = 'left'
        if (n.collapsed && n.descendantCount) {
          ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = '#818cf8'
          ctx.fillText(String(n.descendantCount), tx + TOGGLE_R + 4, cy)
        }
      }
      if (ghost) ctx.restore()
    }

    for (const n of nodes) {
      if (n.key === ghostKey) continue
      const pp = P(n.key); if (!pp) continue
      drawNode(n, pp.x, pp.y, false)
    }
    // dragged ghost on top
    if (ghostKey && drag) {
      const gn = target.get(ghostKey)
      if (gn) drawNode(gn, drag.cursor.x, drag.cursor.y, true)
    }
    ctx.restore()
  }, [])

  // --- animation loop ------------------------------------------------------

  const drawRef = useRef(draw)
  drawRef.current = draw
  const tick = useCallback(() => {
    rafRef.current = null
    const { nodes } = layoutRef.current
    const pos = posRef.current
    const keys = new Set<string>()
    let moving = false
    for (const n of nodes) {
      keys.add(n.key)
      let cur = pos.get(n.key)
      if (!cur) { const p = n.parentKey ? pos.get(n.parentKey) : null; cur = p ? { x: p.x, y: p.y } : { x: n.x, y: n.y }; pos.set(n.key, cur) }
      const dx = n.x - cur.x, dy = n.y - cur.y
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { cur.x += dx * 0.28; cur.y += dy * 0.28; moving = true } else { cur.x = n.x; cur.y = n.y }
    }
    for (const k of [...pos.keys()]) if (!keys.has(k)) pos.delete(k)
    // March the active-delegation dashes; keep the loop alive while any exist.
    if (activeEdgesRef.current.size > 0) { dashOffsetRef.current = (dashOffsetRef.current + 0.5) % 1000; moving = true }
    drawRef.current()
    if (moving || dragRef.current) rafRef.current = requestAnimationFrame(tick)
  }, [])
  const kick = useCallback(() => { if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick) }, [tick])
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    if (longPressRef.current) clearTimeout(longPressRef.current)
  }, [])

  const applyTransform = useCallback((tr: ZoomTransform) => {
    const canvas = canvasRef.current
    if (canvas && zoomBRef.current) select<HTMLCanvasElement, unknown>(canvas).call(zoomBRef.current.transform, tr)
    else { transformRef.current = tr; draw() }
  }, [draw])

  // d3-zoom for pan/wheel/pinch. Node/toggle gestures are owned by our handlers.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const sel = select<HTMLCanvasElement, unknown>(canvas)
    const zoomB = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.25, 2.5])
      .filter((event: Event) => {
        if (event.type === 'wheel') return true
        const [px, py] = pointer(event, canvas)
        const w = transformRef.current.invert([px, py])
        return hitTest(layoutRef.current.nodes, w[0], w[1]) === null && hitToggle(layoutRef.current.nodes, w[0], w[1]) === null
      })
      .on('start', (e: { sourceEvent?: Event }) => { if (e.sourceEvent) { panningRef.current = true; if (canvas) canvas.style.cursor = 'grabbing' } })
      .on('zoom', (e: { transform: ZoomTransform }) => { transformRef.current = e.transform; draw() })
      .on('end', () => { panningRef.current = false; if (canvas) canvas.style.cursor = 'grab' })
    sel.call(zoomB)
    zoomBRef.current = zoomB
    if (fittedRef.current) sel.call(zoomB.transform, transformRef.current)
    return () => { sel.on('.zoom', null); zoomBRef.current = null }
  }, [draw])

  // Fit on first layout, and re-fit whenever the focus filter toggles (the tree
  // shape changes dramatically); otherwise animate to new targets in place.
  const fitFilterRef = useRef(filterAlerted)
  useEffect(() => {
    const container = containerRef.current
    if (!container || layout.nodes.length === 0) return
    const filterChanged = fitFilterRef.current !== filterAlerted
    fitFilterRef.current = filterAlerted
    if (fittedRef.current && !filterChanged) { kick(); return }
    posRef.current = new Map(layout.nodes.map((n) => [n.key, { x: n.x, y: n.y }]))
    const W = container.clientWidth || 800
    const k = Math.max(0.45, Math.min(1, (W - 40) / Math.max(layout.width, 1)))
    fittedRef.current = true
    applyTransform(zoomIdentity.translate(Math.max(20, (W - layout.width * k) / 2), 24).scale(k))
  }, [layout, kick, applyTransform, filterAlerted])

  // Repaint on status / cron / shell / task changes (positions unchanged).
  useEffect(() => { draw() }, [statusByKey, taskCountByKey, draw])
  // Start the animation loop when a delegation goes active (marching dashes).
  useEffect(() => { if (activeEdges.size > 0) kick() }, [activeEdges, kick])

  // --- pointer interaction -------------------------------------------------

  const worldAt = (e: React.PointerEvent): XY => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const [x, y] = transformRef.current.invert([e.clientX - rect.left, e.clientY - rect.top])
    return { x, y }
  }
  const setCursor = (c: string) => { if (canvasRef.current) canvasRef.current.style.cursor = c }
  const showHint = (text: string, clientX: number, clientY: number) => {
    const el = hintRef.current, cont = containerRef.current
    if (!el || !cont) return
    const r = cont.getBoundingClientRect()
    el.textContent = text
    el.style.left = `${clientX - r.left + 16}px`
    el.style.top = `${clientY - r.top + 16}px`
    el.style.opacity = '1'
  }
  const hideHint = () => { if (hintRef.current) hintRef.current.style.opacity = '0' }

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return // left button only — right opens the context menu
    setMenu(null)
    const { x: wx, y: wy } = worldAt(e)
    const tog = hitToggle(layoutRef.current.nodes, wx, wy)
    if (tog) { toggleCollapse(tog.key); return }
    const hit = hitTest(layoutRef.current.nodes, wx, wy)
    if (!hit) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { key: hit.key, kind: hit.kind, subtree: subtreeKeys(layoutRef.current.nodes, hit.key), moved: false, dropKey: null, cursor: { x: wx, y: wy }, start: { x: e.clientX, y: e.clientY } }
    // Touch long-press (no movement) opens the context menu, mirroring right-click.
    if (e.pointerType === 'touch') {
      const cx = e.clientX, cy = e.clientY, key = hit.key
      longPressRef.current = setTimeout(() => {
        longPressRef.current = null
        const d = dragRef.current
        if (d && !d.moved) { dragRef.current = null; hideHint(); setMenu({ x: cx, y: cy, key }) }
      }, 500)
    }
  }, [toggleCollapse])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (drag) {
      drag.cursor = worldAt(e)
      // Only promote to a drag past the threshold (so a jittery click stays a
      // click). Al is the fixed root — never draggable.
      const past = Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) > DRAG_THRESHOLD
      if (past && longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null }
      if (drag.kind !== 'al' && (drag.moved || past)) {
        drag.moved = true
        const target = hitTest(layoutRef.current.nodes, drag.cursor.x, drag.cursor.y, drag.subtree)
        drag.dropKey = target ? target.key : null
        setCursor('grabbing')
        showHint(
          target
            ? target.kind === 'group' ? `Into ${target.title}` : target.kind === 'al' ? `To top level` : `Report to ${target.title}`
            : 'Release to cancel',
          e.clientX, e.clientY,
        )
        kick()
      }
      return
    }
    if (panningRef.current) { setCursor('grabbing'); return }
    // hover: cursor + highlight (folders are now selectable too)
    const { x: wx, y: wy } = worldAt(e)
    const tog = hitToggle(layoutRef.current.nodes, wx, wy)
    const hit = tog ? null : hitTest(layoutRef.current.nodes, wx, wy)
    const hoverKey = tog ? tog.key : hit ? hit.key : null
    setCursor(tog || hit ? 'pointer' : 'grab')
    if (hoverRef.current !== hoverKey) { hoverRef.current = hoverKey; draw() }
  }, [draw, kick])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null }
    const drag = dragRef.current
    dragRef.current = null
    hideHint()
    try { canvasRef.current?.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    if (!drag) return // long-press already consumed it (menu opened)
    if (!drag.moved) { onPick(drag.key); return } // click → open agent / select folder
    const { x: wx, y: wy } = worldAt(e)
    const target = hitTest(layoutRef.current.nodes, wx, wy, drag.subtree)
    // Freeze at the drop point so it slides home (or back, on cancel).
    posRef.current.set(drag.key, { x: drag.cursor.x, y: drag.cursor.y })
    // Drop on a node = reparent. Drop on empty space = CANCEL (snap back) — not
    // "make root", which was too easy to trigger by accident. To move something
    // to the top level, drop it on Al or use the context menu.
    if (target) setAgentManager(drag.key, target.key) // optimistic → layout recomputes
    setCursor('grab')
    kick()
  }, [onPick, setAgentManager, kick])

  const onPointerLeave = useCallback(() => {
    hideHint()
    if (dragRef.current) return
    setCursor('default')
    if (hoverRef.current !== null) { hoverRef.current = null; draw() }
  }, [draw])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const [wx, wy] = transformRef.current.invert([e.clientX - rect.left, e.clientY - rect.top])
    const hit = hitTest(layoutRef.current.nodes, wx, wy)
    setMenu(hit ? { x: e.clientX, y: e.clientY, key: hit.key } : null)
  }, [])

  // Build the context-menu actions for the right-clicked node — mirrors the
  // session-list menu (fork / reload / rename …) plus org-specific verbs.
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const role = agentRoles.find((r) => r.key === menu.key)
    if (!role) return []
    const live = sessions.find((s) => s.agentKey === role.key && s.status !== 'ended')
    const isFolder = !!role.folder
    const isAl = role.key === 'al'
    const items: ContextMenuItem[] = [{ label: 'Show info', onClick: () => openRoleInfo(role.key) }]
    if (!isFolder && !isAl) {
      if (live) {
        items.push({ label: 'Open', onClick: () => onPick(role.key) })
        items.push({ label: 'Fork', onClick: () => forkSession(live.id) })
        items.push({ label: 'Reload history', onClick: () => reloadSessionHistory(live.id) })
        items.push({ label: 'Reload role', onClick: () => reloadSession(live.id) })
      } else {
        items.push({ label: 'Revive', onClick: () => reviveAgent(role.key) })
      }
      items.push({ label: 'Delegate task…', onClick: async () => {
        const b = await showPrompt('What should they do?', { title: `Delegate to ${role.title}`, placeholder: 'e.g. add a dark-mode toggle' })
        if (b?.trim()) delegate(role.key, b.trim())
      } })
    }
    if (isAl) items.push({ label: 'Open', onClick: () => onPick(role.key) })
    if (!isAl) {
      items.push({ label: 'Rename', onClick: async () => {
        const n = await showPrompt('Name', { title: `Rename ${isFolder ? 'folder' : 'agent'}`, defaultValue: role.title })
        if (n?.trim()) renameRole(role.key, n.trim())
      } })
    }
    if (isFolder || isAl) {
      items.push({ label: 'New folder inside', onClick: async () => {
        const n = await showPrompt('Folder name', { title: 'New folder', placeholder: 'e.g. Work' })
        if (n?.trim()) createFolder(n.trim(), role.key)
      } })
    }
    if (!isAl && role.manager !== null) {
      items.push({ label: 'Move to top level', onClick: () => setAgentManager(role.key, null) })
    }
    if (!isAl) {
      if (live && !isFolder) items.push({ label: 'Park', onClick: () => killSession(live.id), destructive: true })
      items.push({ label: isFolder ? 'Delete folder' : 'Delete role', destructive: true, onClick: async () => {
        const ok = await showConfirm(
          isFolder ? 'Its children become roots.' : 'This removes its role file and kills any live session.',
          { title: `Delete ${isFolder ? 'folder' : 'agent'} "${role.title}"?`, danger: true, confirmLabel: 'Delete' },
        )
        if (ok) deleteRole(role.key)
      } })
    }
    return items
  }, [menu, agentRoles, sessions, onPick, openRoleInfo, delegate, forkSession, reloadSessionHistory, reloadSession, reviveAgent, renameRole, createFolder, setAgentManager, killSession, deleteRole])

  if (layout.nodes.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-text-tertiary">No agent roles yet</div>
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        style={{ width: '100%', height: '100%', cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
      />
      {!filterAlerted && (
        <div className="absolute top-2 right-2 flex gap-1">
          <button onClick={async () => { const name = await showPrompt('Folder name', { title: 'New folder', placeholder: 'e.g. Work' }); if (name?.trim()) createFolder(name.trim()) }} className="flex items-center gap-1 rounded border border-border bg-surface-2/80 px-1.5 py-1 text-[11px] text-text-tertiary hover:text-text-primary backdrop-blur-sm" title="New folder"><FolderPlus size={13} /></button>
          <button onClick={() => persistCollapsed(new Set(collapsibleKeys))} className="rounded border border-border bg-surface-2/80 p-1 text-text-tertiary hover:text-text-primary backdrop-blur-sm" title="Collapse all"><Minimize2 size={13} /></button>
          <button onClick={() => persistCollapsed(new Set())} className="rounded border border-border bg-surface-2/80 p-1 text-text-tertiary hover:text-text-primary backdrop-blur-sm" title="Expand all"><Maximize2 size={13} /></button>
        </div>
      )}
      {filterAlerted && layout.nodes.length <= 1 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-text-tertiary">Nothing needs you</div>
      )}
      <div ref={hintRef} className="pointer-events-none absolute z-10 rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text-primary shadow-md opacity-0 transition-opacity duration-100" style={{ left: 0, top: 0 }} />
      <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-text-tertiary">
        {filterAlerted ? 'focused on what needs you · clear the filter to see everyone' : 'click to open · right-click for menu · drag onto a folder/agent to move · ＋/－ to collapse'}
      </div>
      {menu && <ContextMenuView items={menuItems} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
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

/** A small shell (terminal), cron (clock), or task (delegation) icon + count.
 *  Returns the next x. */
function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, kind: 'shell' | 'cron' | 'task', count: number): number {
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.3
  if (kind === 'shell') {
    ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x + 3.5, y); ctx.lineTo(x, y + 3); ctx.stroke()        // ›
    ctx.beginPath(); ctx.moveTo(x + 5, y + 3.5); ctx.lineTo(x + 9, y + 3.5); ctx.stroke()                     // _
  } else if (kind === 'cron') {
    ctx.beginPath(); ctx.arc(x + 4.5, y, 4.5, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x + 4.5, y); ctx.lineTo(x + 4.5, y - 2.6); ctx.moveTo(x + 4.5, y); ctx.lineTo(x + 6.6, y + 1.2); ctx.stroke()
  } else { // task: a downward arrow (work flows down the org)
    ctx.beginPath(); ctx.moveTo(x + 4.5, y - 4); ctx.lineTo(x + 4.5, y + 3.5); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x + 1.8, y + 0.8); ctx.lineTo(x + 4.5, y + 3.8); ctx.lineTo(x + 7.2, y + 0.8); ctx.stroke()
  }
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText(String(count), x + 12, y)
  return x + 12 + ctx.measureText(String(count)).width + 9
}
