// Circles view — canvas-based circle-pack visualization of the vault tree.
//
// Architecture (after iteration):
// - Pure logic lives in `circles-view-helpers.ts` (and has unit tests).
// - One <canvas>. Paint loop is rAF + dirty flag. Reads from refs, never React state.
// - d3-zoom owns pan / wheel / pinch. Its filter REJECTS pointerdowns over a file
//   so file gestures are entirely my code's domain (no race with d3-zoom).
// - File interaction is long-press to lift (400 ms, mobile + desktop). Movement
//   before the timer fires cancels the lift; a quick pointerup fires the native
//   click event which opens the file. After lift, my own drag drives via
//   setPointerCapture and a captured pointer; d3-zoom never sees these events.
// - Folder / background tap: I just listen to native `click`. d3-zoom suppresses
//   click after a pan, so this naturally distinguishes tap from pan.
// - Hover tooltip mutates DOM directly via a ref; no React re-render per move.
// - Click-to-focus uses d3-zoom's native transition for clean cancellation.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import 'd3-transition'
import { easeCubicOut } from 'd3-ease'
import { useNotesStore } from '@/store/notes'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { showConfirm } from '@/dialog'
import { ChevronRight, ArrowUp, FolderTree, NotebookPen, Search, X } from 'lucide-react'
import {
  ROOT_PATH,
  buildHierarchy,
  findNode,
  parentPathOf,
  fitTransform,
  hitTest,
  findDeepestFolderAt,
  truncateLabel,
  coverFadeThreshold,
  isAncestorChainOpen,
  type NodeDatum,
  type PackNode,
} from './circles-view-helpers'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENT_WINDOW_MS = 5 * 60_000
const ZOOM_MIN = 0.5
const ZOOM_MAX = 200
const LABEL_PX = 13
const MIN_LABEL_APPARENT_R = 22
const LONG_PRESS_MS = 400
const CANCEL_DRAG_PX = 6
const FOCUS_ANIM_MS = 550

interface Palette {
  surface0: string
  surface1: string
  surface2: string
  border: string
  textPrimary: string
  textSecondary: string
  accent: string
}

function readPalette(probe: HTMLElement): Palette {
  const cs = getComputedStyle(probe)
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    surface0: get('--color-surface-0', '#0a0a0a'),
    surface1: get('--color-surface-1', '#141414'),
    surface2: get('--color-surface-2', '#1f1f1f'),
    border: get('--color-border', '#2a2a2a'),
    textPrimary: get('--color-text-primary', '#e5e5e5'),
    textSecondary: get('--color-text-secondary', '#a3a3a3'),
    accent: get('--color-accent', '#facc15'),
  }
}

function fmtAge(ms: number): string {
  const days = (Date.now() - ms) / 86_400_000
  if (days < 1) {
    const h = days * 24
    if (h < 1) return 'just now'
    return `${Math.round(h)}h ago`
  }
  if (days < 30) return `${Math.round(days)}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${(days / 365).toFixed(1)}y ago`
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CirclesView = memo(function CirclesView() {
  const files = useNotesStore((s) => s.files)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)
  const openFile = useNotesStore((s) => s.openFile)
  const renameFileAction = useNotesStore((s) => s.renameFile)
  const setViewMode = useNotesStore((s) => s.setViewMode)
  const isMobile = useIsMobile()
  const pushToast = useUiStore((s) => s.pushToast)

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Refs (don't trigger React re-renders)
  const paletteRef = useRef<Palette | null>(null)
  const transformRef = useRef<ZoomTransform>(zoomIdentity)
  const zoomBehaviorRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const rootRef = useRef<PackNode | null>(null)
  const renderableRef = useRef<PackNode[]>([])
  const dirtyRef = useRef(true)
  const hoverPathRef = useRef<string | null>(null)
  const activeFilePathRef = useRef<string | null>(activeFilePath)
  const matchesRef = useRef<Set<string>>(new Set())
  const focusPathRef = useRef<string>(ROOT_PATH)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const clickGuardUntilRef = useRef(0)
  const dragRef = useRef<{
    node: PackNode
    curUx: number
    curUy: number
    pointerId: number
  } | null>(null)

  const [focusPath, setFocusPath] = useState<string>(ROOT_PATH)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => { focusPathRef.current = focusPath }, [focusPath])
  useEffect(() => { activeFilePathRef.current = activeFilePath; dirtyRef.current = true }, [activeFilePath])

  const root = useMemo(() => buildHierarchy(files), [files])
  useEffect(() => { rootRef.current = root; dirtyRef.current = true }, [root])

  // Snap focus back to root if the current focus path disappeared
  useEffect(() => {
    if (!root) return
    if (!findNode(root, focusPath)) setFocusPath(ROOT_PATH)
  }, [root, focusPath])

  const focusNode: PackNode | null = useMemo(() => {
    if (!root) return null
    return findNode(root, focusPath) ?? (root as PackNode)
  }, [root, focusPath])

  const crumbs: PackNode[] = useMemo(() => {
    if (!focusNode) return []
    const out: PackNode[] = []
    let cur: PackNode | null = focusNode
    while (cur) {
      out.unshift(cur)
      cur = cur.parent as PackNode | null
    }
    return out
  }, [focusNode])

  const matches = useMemo(() => {
    if (!search.trim() || !root) return new Set<string>()
    const q = search.toLowerCase()
    const out = new Set<string>()
    root.each((d) => {
      if (d.data.path === ROOT_PATH) return
      if (d.data.path.toLowerCase().includes(q)) {
        out.add(d.data.path)
        let p = d.parent as PackNode | null
        while (p) { out.add(p.data.path); p = p.parent as PackNode | null }
      }
    })
    return out
  }, [search, root])
  useEffect(() => { matchesRef.current = matches; dirtyRef.current = true }, [matches])

  const popLevel = useCallback(() => {
    const r = rootRef.current
    if (!r) return
    const cur = findNode(r, focusPathRef.current) ?? r
    const parent = (cur.parent as PackNode | null) ?? null
    if (parent) setFocusPath(parent.data.path)
  }, [])

  const handleRename = useCallback(
    async (from: string, to: string) => {
      if (to === from) return
      try {
        await renameFileAction(from, to)
        pushToast({ kind: 'success', message: `Moved to ${to}` })
      } catch (err) {
        pushToast({ kind: 'error', message: `Move failed: ${(err as Error).message}` })
      }
    },
    [renameFileAction, pushToast],
  )

  // -------------------------------------------------------------------------
  // Build / wire — runs once per file list
  // -------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !root) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    paletteRef.current = readPalette(container)

    const all = (root as PackNode).descendants() as PackNode[]
    // Reverse so leaves render first, parents on top (Machete-style LoD)
    renderableRef.current = all.filter((d) => d.depth > 0).reverse()

    // --------------------------- Resize / DPR ---------------------------
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === sizeRef.current.w && h === sizeRef.current.h && dpr === sizeRef.current.dpr) return
      sizeRef.current = { w, h, dpr }
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      dirtyRef.current = true
    }
    const ro = new ResizeObserver(resize)
    ro.observe(container)
    resize()

    // --------------------------- d3-zoom setup --------------------------
    const z = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([ZOOM_MIN, ZOOM_MAX])
      .filter((event) => {
        // Reject right-click / ctrl+click
        if (event.ctrlKey) return false
        if (event.type === 'mousedown' && event.button !== 0) return false
        if (event.type === 'wheel') return true
        // For pointerdown / mousedown / touchstart: reject if the hit resolves to a file.
        // (Files are handled by my long-press logic; d3-zoom mustn't even start.)
        const r = rootRef.current
        if (!r) return true
        let clientX: number, clientY: number
        if (event.type === 'touchstart') {
          const tt = (event as TouchEvent).touches?.[0]
          if (!tt) return true
          clientX = tt.clientX
          clientY = tt.clientY
        } else {
          clientX = (event as MouseEvent | PointerEvent).clientX
          clientY = (event as MouseEvent | PointerEvent).clientY
        }
        const rect = canvas.getBoundingClientRect()
        const sx = clientX - rect.left
        const sy = clientY - rect.top
        const t = transformRef.current
        const ux = (sx - t.x) / t.k
        const uy = (sy - t.y) / t.k
        const { w: W, h: H } = sizeRef.current
        const hit = hitTest(r, ux, uy, t.k, coverFadeThreshold(W, H))
        if (hit?.data.isFile) return false
        return true
      })
      .on('zoom', (event) => {
        transformRef.current = event.transform
        dirtyRef.current = true
      })

    const csel = select(canvas)
    csel.call(z).on('dblclick.zoom', null)
    zoomBehaviorRef.current = z

    // Initial fit
    const initialFocus = findNode(root as PackNode, focusPathRef.current) ?? (root as PackNode)
    csel.call(
      z.transform as any,
      fitTransform(initialFocus as PackNode, sizeRef.current.w, sizeRef.current.h),
    )

    // --------------------------- Pointer handlers -----------------------
    const screenToUser = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      const t = transformRef.current
      return {
        ux: (clientX - rect.left - t.x) / t.k,
        uy: (clientY - rect.top - t.y) / t.k,
      }
    }

    const setCursor = (style: string) => {
      if (canvas.style.cursor !== style) canvas.style.cursor = style
    }

    const updateTooltipForHit = (hit: PackNode | null) => {
      const el = tooltipRef.current
      if (!el || isMobile) return
      if (!hit) {
        el.style.display = 'none'
        return
      }
      const d = hit.data
      const pathText = d.path === ROOT_PATH ? '/' : d.path
      const meta = d.isFile ? ` · ${fmtSize(d.size)} · ${fmtAge(d.mtime)}` : ''
      el.textContent = pathText + meta
      el.style.display = ''
    }

    let pressTimer: ReturnType<typeof setTimeout> | null = null
    let pressClient: { x: number; y: number; pointerId: number } | null = null

    const clearPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
      pressClient = null
    }

    const armDrag = (node: PackNode, ux: number, uy: number, pointerId: number) => {
      dragRef.current = { node, curUx: ux, curUy: uy, pointerId }
      try { canvas.setPointerCapture(pointerId) } catch {}
      if (navigator.vibrate) navigator.vibrate(15)
      setCursor('grabbing')
      dirtyRef.current = true
    }

    const releaseDrag = async () => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      try { canvas.releasePointerCapture(d.pointerId) } catch {}
      clickGuardUntilRef.current = Date.now() + 500
      setCursor('grab')
      dirtyRef.current = true

      const r = rootRef.current
      if (!r) return
      const target = findDeepestFolderAt(r, d.curUx, d.curUy, d.node.data.path)
      const newParent = target?.data.path ?? ROOT_PATH
      if (newParent === parentPathOf(d.node.data.path)) return
      const filename = d.node.data.path.split('/').pop()!
      const newPath = newParent === ROOT_PATH ? filename : `${newParent}/${filename}`
      const ok = await showConfirm(
        `Move "${d.node.data.name}.md" to ${newParent === ROOT_PATH ? '/' : newParent}?`,
        { title: 'Move file', confirmLabel: 'Move' },
      )
      if (!ok) return
      await handleRename(d.node.data.path, newPath)
    }

    const onPointerDown = (event: PointerEvent) => {
      // Already dragging? Ignore secondary pointer.
      if (dragRef.current) return
      if (event.button !== 0 && event.pointerType === 'mouse') return
      const r = rootRef.current
      if (!r) return
      const { ux, uy } = screenToUser(event.clientX, event.clientY)
      const { w: W, h: H } = sizeRef.current
      const hit = hitTest(r, ux, uy, transformRef.current.k, coverFadeThreshold(W, H))
      if (!hit?.data.isFile) return // not a file — d3-zoom or click handles it
      pressClient = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
      pressTimer = setTimeout(() => {
        pressTimer = null
        // Re-derive ux/uy at fire time (cursor may have shifted slightly within the threshold)
        const p = pressClient
        if (!p) return
        const { ux: ux2, uy: uy2 } = screenToUser(p.x, p.y)
        pressClient = null
        armDrag(hit, ux2, uy2, p.pointerId)
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (event: PointerEvent) => {
      // Drag in progress
      const d = dragRef.current
      if (d && event.pointerId === d.pointerId) {
        const { ux, uy } = screenToUser(event.clientX, event.clientY)
        d.curUx = ux
        d.curUy = uy
        dirtyRef.current = true
        return
      }

      // Long-press candidate — cancel if pointer moved too far
      if (pressTimer && pressClient && event.pointerId === pressClient.pointerId) {
        const dx = event.clientX - pressClient.x
        const dy = event.clientY - pressClient.y
        if (dx * dx + dy * dy > CANCEL_DRAG_PX * CANCEL_DRAG_PX) {
          clearPress()
        }
      }

      // Hover tooltip + cursor — only when not dragging and on mouse pointers
      if (event.pointerType === 'mouse') {
        const r = rootRef.current
        if (!r) return
        const { ux, uy } = screenToUser(event.clientX, event.clientY)
        const { w: W, h: H } = sizeRef.current
        const hit = hitTest(r, ux, uy, transformRef.current.k, coverFadeThreshold(W, H))
        const newPath = hit?.data.path ?? null
        if (newPath !== hoverPathRef.current) {
          hoverPathRef.current = newPath
          updateTooltipForHit(hit)
          setCursor(hit ? (hit.data.isFile ? 'pointer' : 'zoom-in') : 'grab')
          dirtyRef.current = true
        }
      }
    }

    const onPointerUp = (event: PointerEvent) => {
      if (dragRef.current && event.pointerId === dragRef.current.pointerId) {
        void releaseDrag()
        return
      }
      if (pressTimer && pressClient && event.pointerId === pressClient.pointerId) {
        // Quick tap on a file — let the native click event fire (opens file)
        clearPress()
      }
    }

    const onPointerCancel = (event: PointerEvent) => {
      if (dragRef.current && event.pointerId === dragRef.current.pointerId) {
        // Cancel cleanly without dropping
        dragRef.current = null
        try { canvas.releasePointerCapture(event.pointerId) } catch {}
        setCursor('grab')
        dirtyRef.current = true
      }
      if (pressTimer && pressClient && event.pointerId === pressClient.pointerId) clearPress()
    }

    const onPointerLeave = () => {
      if (hoverPathRef.current !== null) {
        hoverPathRef.current = null
        updateTooltipForHit(null)
        setCursor('grab')
        dirtyRef.current = true
      }
    }

    const onClick = (event: MouseEvent) => {
      if (Date.now() < clickGuardUntilRef.current) return
      const r = rootRef.current
      if (!r) return
      const { ux, uy } = screenToUser(event.clientX, event.clientY)
      const { w: W, h: H } = sizeRef.current
      const hit = hitTest(r, ux, uy, transformRef.current.k, coverFadeThreshold(W, H))
      if (!hit) { popLevel(); return }
      if (hit.data.isFile) { void openFile(hit.data.path); return }
      setFocusPath(hit.data.path)
    }

    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      popLevel()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('lostpointercapture', onPointerCancel)
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('contextmenu', onContextMenu)

    // --------------------------- rAF render loop ------------------------
    let rafId = 0
    const loop = () => {
      rafId = requestAnimationFrame(loop)
      if (!dirtyRef.current) return
      dirtyRef.current = false
      paint(ctx)
    }
    rafId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      clearPress()
      csel.on('.zoom', null)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('lostpointercapture', onPointerCancel)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      zoomBehaviorRef.current = null
      paletteRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, isMobile])

  // -------------------------------------------------------------------------
  // Animated zoom-to-focus when focusPath changes — d3-zoom native transition
  // -------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    const z = zoomBehaviorRef.current
    const r = rootRef.current
    if (!canvas || !z || !r) return
    const node = findNode(r, focusPath) ?? r
    const W = sizeRef.current.w
    const H = sizeRef.current.h
    if (W === 0 || H === 0) return
    const target = fitTransform(node as PackNode, W, H)
    select(canvas)
      .transition()
      .duration(FOCUS_ANIM_MS)
      .ease(easeCubicOut)
      .call(z.transform as any, target)
    // User input cancels the transition automatically (d3-zoom default)
  }, [focusPath])

  // -------------------------------------------------------------------------
  // Keyboard: / opens search
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useUiStore.getState().activePane !== 'notes') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/' && !searchOpen) {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [searchOpen])

  // -------------------------------------------------------------------------
  // Paint — pure, reads from refs only
  // -------------------------------------------------------------------------
  function paint(ctx: CanvasRenderingContext2D) {
    const palette = paletteRef.current
    const nodes = renderableRef.current
    if (!palette || nodes.length === 0) return
    const { w, h, dpr } = sizeRef.current
    const t = transformRef.current
    const fadeThreshold = coverFadeThreshold(w, h)

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = palette.surface0
    ctx.fillRect(0, 0, w, h)

    const active = activeFilePathRef.current
    const drag = dragRef.current
    const matches = matchesRef.current
    const hasSearch = matches.size > 0
    const hovered = hoverPathRef.current

    // Pass 1: circles
    ctx.save()
    ctx.translate(t.x, t.y)
    ctx.scale(t.k, t.k)

    for (const d of nodes) {
      if (drag?.node === d) continue
      const apparentR = d.r * t.k
      if (apparentR < 0.5) continue
      // Skip nodes hidden behind an opaque ancestor cover
      if (!isAncestorChainOpen(d, t.k, fadeThreshold)) continue

      const isFile = d.data.isFile
      const isFaded = !!d.children && apparentR > fadeThreshold

      ctx.beginPath()
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)

      if (!isFaded) {
        ctx.fillStyle = isFile ? palette.surface2 : palette.surface1
        if (hasSearch && !matches.has(d.data.path)) ctx.globalAlpha = 0.2
        ctx.fill()
        ctx.globalAlpha = 1
      }

      const isActive = isFile && d.data.path === active
      const isMatch = hasSearch && matches.has(d.data.path) && isFile
      ctx.strokeStyle = (isActive || isMatch) ? palette.accent : palette.border
      ctx.lineWidth = (isActive ? 2.4 : (isFile ? 0.5 : 0.4)) / t.k
      ctx.stroke()

      if (!isFile && !isFaded && hovered === d.data.path) {
        ctx.strokeStyle = palette.textSecondary
        ctx.lineWidth = 1.5 / t.k
        ctx.stroke()
      }

      if (isFile && Date.now() - d.data.mtime < RECENT_WINDOW_MS) {
        ctx.strokeStyle = palette.accent
        ctx.lineWidth = 1.5 / t.k
        ctx.globalAlpha = 0.55
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }
    ctx.restore()

    // Pass 2: labels at fixed screen size
    ctx.font = `${LABEL_PX}px ui-sans-serif, system-ui, -apple-system, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const measure = (s: string) => ctx.measureText(s).width

    for (const d of nodes) {
      if (!d.parent) continue
      if (drag?.node === d) continue
      const apparentR = d.r * t.k
      if (apparentR < MIN_LABEL_APPARENT_R) continue
      const isFaded = !!d.children && apparentR > fadeThreshold
      if (isFaded) continue
      // Same visibility check as pass 1 — without this, labels paint over
      // ancestors that visually cover them (the screen-space pass bypasses
      // the painter's algorithm).
      if (!isAncestorChainOpen(d, t.k, fadeThreshold)) continue

      const sx = d.x * t.k + t.x
      const sy = d.y * t.k + t.y
      if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) continue

      const maxW = apparentR * 1.7
      const text = truncateLabel(d.data.name, maxW, measure)
      if (!text) continue

      ctx.fillStyle = d.data.isFile ? palette.textPrimary : palette.textSecondary
      if (hasSearch && !matches.has(d.data.path)) ctx.globalAlpha = 0.25
      ctx.fillText(text, sx, sy)
      ctx.globalAlpha = 1
    }

    // Pass 3: dragged file (last, on top)
    if (drag) {
      const d = drag.node
      ctx.save()
      ctx.translate(t.x, t.y)
      ctx.scale(t.k, t.k)
      ctx.beginPath()
      ctx.arc(drag.curUx, drag.curUy, d.r, 0, Math.PI * 2)
      ctx.fillStyle = palette.surface2
      ctx.fill()
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 2 / t.k
      ctx.stroke()
      ctx.restore()

      const sx = drag.curUx * t.k + t.x
      const sy = drag.curUy * t.k + t.y
      ctx.fillStyle = palette.textPrimary
      ctx.fillText(d.data.name, sx, sy)
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!files.length) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-text-tertiary">
        No notes in vault
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-surface-0 select-none">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border text-xs">
        <button
          onClick={() => setFocusPath(ROOT_PATH)}
          className="p-0.5 text-text-tertiary hover:text-text-primary rounded-sm hover:bg-surface-2 disabled:opacity-40"
          title="Zoom to root"
          disabled={focusPath === ROOT_PATH}
        >
          <ArrowUp size={12} />
        </button>
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden">
          {crumbs.map((c, i) => (
            <div key={c.data.path} className="flex items-center min-w-0">
              {i > 0 && <ChevronRight size={10} className="text-text-tertiary shrink-0" />}
              <button
                onClick={() => setFocusPath(c.data.path)}
                className={`px-1 truncate rounded-sm hover:bg-surface-2 ${
                  i === crumbs.length - 1 ? 'text-text-primary' : 'text-text-secondary'
                }`}
              >
                {c.data.path === ROOT_PATH ? 'vault' : c.data.name}
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => setSearchOpen((v) => !v)}
          className="p-0.5 text-text-tertiary hover:text-text-primary rounded-sm hover:bg-surface-2"
          title="Search (/)"
        >
          <Search size={12} />
        </button>
        <button
          onClick={() => setViewMode('blog')}
          className="p-0.5 text-text-tertiary hover:text-text-primary rounded-sm hover:bg-surface-2"
          title="Switch to blog view"
        >
          <NotebookPen size={12} />
        </button>
        <button
          onClick={() => setViewMode('tree')}
          className="p-0.5 text-text-tertiary hover:text-text-primary rounded-sm hover:bg-surface-2"
          title="Switch to tree view"
        >
          <FolderTree size={12} />
        </button>
      </div>

      {searchOpen && (
        <div className="flex items-center gap-2 px-2 py-1 border-b border-border bg-surface-1">
          <Search size={12} className="text-text-tertiary" />
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by path or name…"
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.size > 0 && root) {
                const firstMatch = [...matches].find((p) => p !== ROOT_PATH)
                if (firstMatch) {
                  const node = findNode(root, firstMatch)
                  if (node) {
                    setFocusPath(node.data.isFile ? (node.parent?.data.path ?? ROOT_PATH) : node.data.path)
                  }
                }
              } else if (e.key === 'Escape') {
                setSearchOpen(false)
                setSearch('')
              }
            }}
          />
          <button
            onClick={() => { setSearchOpen(false); setSearch('') }}
            className="text-text-tertiary hover:text-text-primary"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div ref={containerRef} className="flex-1 min-h-0 relative" style={{ touchAction: 'none' }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', cursor: 'grab', touchAction: 'none' }}
          tabIndex={-1}
        />
        <div
          ref={tooltipRef}
          className="absolute bottom-1 left-1 right-1 pointer-events-none text-[10px] text-text-tertiary bg-surface-1/80 backdrop-blur-sm px-2 py-1 rounded-sm border border-border truncate"
          style={{ display: 'none' }}
        />
      </div>
    </div>
  )
})

// Re-export NodeDatum so it stays a typed value when downstream importers want it
export type { NodeDatum }
