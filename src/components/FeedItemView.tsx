import { useMemo, useEffect, useRef, useCallback, useState } from 'react'
import { useFeedStore } from '@/store/feeds'
import { useUiStore } from '@/store/ui'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { getHubUrl } from '@/hub'
import DOMPurify from 'dompurify'
import { ExternalLink, Rss, MessageSquare, X, Play, ChevronDown, ChevronRight, MoreHorizontal, Trash2, Check } from 'lucide-react'
import { showConfirm } from '@/dialog'

// Make all links open in new tabs after DOMPurify sanitization
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

function extractYoutubeId(url: string): string | null {
  const match = url?.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
}

function isRedditUrl(url: string): boolean {
  return /reddit\.com\/r\//.test(url)
}

// --- HN helpers ---

function extractHNItemId(content: string): string | null {
  const match = content?.match(/news\.ycombinator\.com\/item\?id=(\d+)/)
  return match?.[1] ?? null
}

interface HNComment {
  id: number
  by?: string
  text?: string
  time: number
  children: HNComment[]
  kids?: number[]
  descendants?: number
  score?: number
}

function HNCommentThread({ comment, depth = 0 }: { comment: HNComment; depth?: number }) {
  const [collapsed, setCollapsed] = useState(false)
  if (!comment.text) return null
  const sanitized = DOMPurify.sanitize(comment.text)
  const timeAgo = formatTimeAgo(comment.time)

  const onToggle = (e: React.MouseEvent) => {
    // Don't toggle when clicking a link
    if ((e.target as HTMLElement).closest('a')) return
    // Don't toggle when the user is selecting text (drag-to-highlight)
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().length > 0) return
    e.stopPropagation()
    setCollapsed((c) => !c)
  }

  return (
    <div className={depth > 0 ? 'ml-1.5 sm:ml-3 border-l border-border pl-1.5 sm:pl-3 min-w-0' : 'min-w-0'}>
      <div className="py-1.5 min-w-0">
        <div onClick={onToggle} className="cursor-pointer">
          <div className="flex items-center gap-1.5 text-[10px] text-text-tertiary">
            {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
            <span className="font-medium text-text-secondary">{comment.by}</span>
            <span>·</span>
            <span>{timeAgo}</span>
            {collapsed && comment.children.length > 0 && (
              <span>({comment.children.length} {comment.children.length === 1 ? 'reply' : 'replies'})</span>
            )}
          </div>
          {!collapsed && (
            <div
              className="mt-1 text-xs text-text-secondary leading-relaxed min-w-0 max-w-full overflow-hidden break-words [&_a]:text-blue-400 [&_a]:underline [&_a]:break-all [&_p]:mb-1.5 [&_pre]:bg-surface-2 [&_pre]:p-2 [&_pre]:rounded-sm [&_pre]:overflow-x-auto [&_pre]:text-[11px] [&_pre]:max-w-full [&_code]:text-[11px] [&_code]:break-all"
              dangerouslySetInnerHTML={{ __html: sanitized }}
            />
          )}
        </div>
        {!collapsed && comment.children.map((child) => (
          <HNCommentThread key={child.id} comment={child} depth={depth + 1} />
        ))}
      </div>
    </div>
  )
}

function formatTimeAgo(unixTime: number): string {
  const seconds = Math.floor(Date.now() / 1000) - unixTime
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function HNComments({ itemId }: { itemId: string }) {
  const [comments, setComments] = useState<HNComment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`${getHubUrl()}/feeds/hn/${itemId}?depth=3`)
      .then((r) => r.json())
      .then((data) => { setComments(data); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [itemId])

  if (loading) return <div className="text-xs text-text-tertiary py-2">Loading comments...</div>
  if (error) return <div className="text-xs text-red-400 py-2">Failed to load comments: {error}</div>
  if (!comments) return null

  return (
    <div className="mt-4 border-t border-border pt-3 min-w-0 max-w-full overflow-hidden">
      <h2 className="text-xs font-semibold text-text-primary mb-2">
        {comments.descendants ?? 0} Comments
        {comments.score && <span className="font-normal text-text-tertiary ml-2">{comments.score} points</span>}
      </h2>
      {comments.children?.map((child) => (
        <HNCommentThread key={child.id} comment={child} />
      ))}
    </div>
  )
}

// --- YouTube PiP ---
// Single iframe that lives at Layout level. Two visual modes:
// - Inline: overlays a placeholder in FeedItemView (tracked via rAF)
// - PiP: floats in corner with drag/resize/close chrome

export function YouTubePiP() {
  const pipVideo = useUiStore((s) => s.pipVideo)
  const setPipVideo = useUiStore((s) => s.setPipVideo)
  const activePane = useUiStore((s) => s.activePane)
  const selectedItemId = useFeedStore((s) => s.selectedItemId)
  const items = useFeedStore((s) => s.items)
  const isMobile = useIsMobile()
  const pipRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)

  // Determine if we should overlay the placeholder (inline mode)
  const selectedItem = items.find((i) => i.id === selectedItemId)
  const selectedYoutubeId = selectedItem ? extractYoutubeId(selectedItem.link) : null
  const isInline = activePane === 'feeds' && pipVideo?.youtubeId === selectedYoutubeId

  // Track placeholder position when inline via rAF
  useEffect(() => {
    const pip = pipRef.current
    if (!pip || !isInline) return

    let rafId: number
    const track = () => {
      const placeholder = document.querySelector('[data-pip-placeholder]')
      if (placeholder && pip) {
        const rect = placeholder.getBoundingClientRect()
        pip.style.left = `${rect.left}px`
        pip.style.top = `${rect.top}px`
        pip.style.width = `${rect.width}px`
        pip.style.height = `${rect.height}px`
        pip.style.right = 'auto'
        pip.style.bottom = 'auto'
        pip.style.aspectRatio = 'auto'
        pip.style.borderRadius = '0.125rem'
      }
      rafId = requestAnimationFrame(track)
    }
    rafId = requestAnimationFrame(track)
    return () => cancelAnimationFrame(rafId)
  }, [isInline])

  // Reset to corner position when switching to PiP mode
  useEffect(() => {
    const pip = pipRef.current
    if (!pip || isInline) return
    pip.style.left = ''
    pip.style.top = ''
    pip.style.right = '16px'
    pip.style.bottom = '80px'
    pip.style.width = isMobile ? '100%' : '360px'
    pip.style.height = ''
    pip.style.aspectRatio = '16/9'
    pip.style.borderRadius = isMobile ? '0' : '0.5rem'
    if (isMobile) {
      pip.style.left = '0'
      pip.style.right = '0'
      pip.style.bottom = '56px'
    }
  }, [isInline, isMobile])

  const closePip = useCallback(() => setPipVideo(null), [setPipVideo])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, iframe')) return
    const pip = pipRef.current
    if (!pip) return
    e.preventDefault()
    pip.setPointerCapture(e.pointerId)
    const rect = pip.getBoundingClientRect()
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragState.current) {
      const pip = pipRef.current
      if (!pip) return
      pip.style.left = `${dragState.current.origX + (e.clientX - dragState.current.startX)}px`
      pip.style.top = `${dragState.current.origY + (e.clientY - dragState.current.startY)}px`
      pip.style.right = 'auto'
      pip.style.bottom = 'auto'
    }
  }, [])

  const onPointerUp = useCallback(() => {
    dragState.current = null
    resizeState.current = null
  }, [])

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    const pip = pipRef.current
    if (!pip) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    resizeState.current = { startX: e.clientX, startY: e.clientY, origW: pip.offsetWidth, origH: pip.offsetHeight }
  }, [])

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeState.current) return
    const pip = pipRef.current
    if (!pip) return
    pip.style.width = `${Math.max(240, resizeState.current.origW + (e.clientX - resizeState.current.startX))}px`
    pip.style.height = `${Math.max(160, resizeState.current.origH + (e.clientY - resizeState.current.startY))}px`
    pip.style.aspectRatio = 'auto'
  }, [])

  if (!pipVideo) return null

  return (
    <div
      ref={pipRef}
      className={`fixed z-50 flex flex-col overflow-hidden ${isInline ? '' : 'bg-surface-0 border border-border shadow-2xl'}`}
      onPointerDown={!isInline && !isMobile ? onPointerDown : undefined}
      onPointerMove={!isInline && !isMobile ? onPointerMove : undefined}
      onPointerUp={!isInline ? onPointerUp : undefined}
    >
      {/* Chrome: title bar + close — only in PiP mode */}
      {!isInline && (
        <div className={`flex items-center justify-between px-2 py-1 bg-surface-1 text-[10px] text-text-secondary select-none ${isMobile ? '' : 'cursor-grab'}`}>
          <span className="truncate">{pipVideo.title}</span>
          <button onClick={closePip} className="p-0.5 hover:text-text-primary transition-colors">
            <X size={12} />
          </button>
        </div>
      )}
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${pipVideo.youtubeId}?autoplay=1`}
        className="w-full flex-1"
        style={{ pointerEvents: 'auto' }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        title="YouTube video"
      />
      {/* Resize handle — PiP desktop only */}
      {!isInline && !isMobile && (
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onPointerUp}
        />
      )}
    </div>
  )
}

// --- Feed Item View ---

export function FeedItemView() {
  const items = useFeedStore((s) => s.items)
  const selectedItemId = useFeedStore((s) => s.selectedItemId)
  const feeds = useFeedStore((s) => s.feeds)
  const updateFeed = useFeedStore((s) => s.updateFeed)
  const deleteFeed = useFeedStore((s) => s.deleteFeed)
  const pipVideo = useUiStore((s) => s.pipVideo)
  const setPipVideo = useUiStore((s) => s.setPipVideo)
  const contentRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  const item = items.find((i) => i.id === selectedItemId)
  const feed = item ? feeds.find((f) => f.id === item.feedId) : null

  const sanitizedContent = useMemo(() => {
    if (!item?.content) return ''
    return DOMPurify.sanitize(item.content, {
      ADD_TAGS: ['iframe'],
      ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'src', 'target'],
      FORBID_TAGS: ['script', 'style'],
    })
  }, [item?.content])

  // Scroll to top when item changes
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0)
  }, [selectedItemId])

  if (!item) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Rss size={20} className="mx-auto mb-2 text-text-tertiary" />
          <span className="text-xs text-text-tertiary">Select an article to read</span>
        </div>
      </div>
    )
  }

  const youtubeId = extractYoutubeId(item.link)
  const isReddit = isRedditUrl(item.link)
  const hnItemId = extractHNItemId(item.content)
  const isPlayingThis = pipVideo?.youtubeId === youtubeId

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {/* Article header */}
      <div className="px-4 py-3 border-b border-border flex-shrink-0">
        <h1 className="text-sm font-semibold text-text-primary leading-tight break-words">
          {item.title}
        </h1>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {feed && (
            <span className="text-[10px] text-text-tertiary">{feed.title}</span>
          )}
          {item.author && (
            <>
              <span className="text-[10px] text-text-tertiary">·</span>
              <span className="text-[10px] text-text-tertiary">{item.author}</span>
            </>
          )}
          <span className="text-[10px] text-text-tertiary">·</span>
          <span className="text-[10px] text-text-tertiary">
            {new Date(item.publishedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
          <span className="flex items-center gap-2 ml-auto">
            {(isReddit || hnItemId) && (
              <a
                href={hnItemId ? `https://news.ycombinator.com/item?id=${hnItemId}` : item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                <MessageSquare size={10} />
                <span>{hnItemId ? 'HN' : 'Comments'}</span>
              </a>
            )}
            {item.link && (
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                <ExternalLink size={10} />
                <span>Open</span>
              </a>
            )}
            {feed && (
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex items-center text-text-tertiary hover:text-text-secondary transition-colors p-0.5"
                  aria-label="Feed options"
                >
                  <MoreHorizontal size={12} />
                </button>
                {menuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-20 bg-surface-0 border border-border rounded-sm shadow-lg py-0.5 min-w-44">
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-tertiary">
                      Limit {feed.title}
                    </div>
                    {[3, 5, 10, 25, null].map((n) => {
                      const current = feed.maxItems ?? null
                      const active = current === n
                      const label = n === null ? 'Unlimited' : `Top ${n}`
                      return (
                        <button
                          key={String(n)}
                          onClick={() => {
                            updateFeed(feed.id, { maxItems: n })
                            setMenuOpen(false)
                          }}
                          className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
                        >
                          <span className="w-3 flex-shrink-0">
                            {active && <Check size={11} className="text-text-tertiary" />}
                          </span>
                          {label}
                        </button>
                      )
                    })}
                    <div className="border-t border-border my-0.5" />
                    <button
                      onClick={async () => {
                        setMenuOpen(false)
                        if (await showConfirm(`Unsubscribe from ${feed.title}?`, { title: 'Unsubscribe', danger: true, confirmLabel: 'Unsubscribe' })) {
                          deleteFeed(feed.id)
                        }
                      }}
                      className="flex items-center gap-2 w-full px-3 py-1 text-xs text-red-400 hover:bg-surface-1 transition-colors"
                    >
                      <Trash2 size={11} />
                      Unsubscribe
                    </button>
                  </div>
                )}
              </div>
            )}
          </span>
        </div>
      </div>

      {/* Article content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 px-4 py-3">
        {/* YouTube: placeholder (overlaid by PiP iframe), or thumbnail with play */}
        {youtubeId && (
          isPlayingThis ? (
            // Empty placeholder — YouTubePiP overlays this with the real iframe
            <div data-pip-placeholder className="mb-3 aspect-video w-full max-w-2xl rounded-sm" />
          ) : pipVideo ? (
            // Different video is playing in PiP
            <button
              className="mb-3 aspect-video w-full max-w-2xl relative group cursor-pointer rounded-sm overflow-hidden"
              onClick={() => setPipVideo({ youtubeId, title: item.title })}
            >
              <img
                src={`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`}
                alt=""
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/40 transition-colors">
                <div className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center">
                  <Play size={20} className="text-white ml-0.5" fill="white" />
                </div>
              </div>
            </button>
          ) : (
            // Nothing playing — show thumbnail with play
            <button
              className="mb-3 aspect-video w-full max-w-2xl relative group cursor-pointer rounded-sm overflow-hidden"
              onClick={() => setPipVideo({ youtubeId, title: item.title })}
            >
              <img
                src={`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`}
                alt=""
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/40 transition-colors">
                <div className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center">
                  <Play size={20} className="text-white ml-0.5" fill="white" />
                </div>
              </div>
            </button>
          )
        )}

        {/* Thumbnail for items with imageUrl but no YouTube embed */}
        {!youtubeId && item.imageUrl && (
          <img
            src={item.imageUrl}
            alt=""
            className="max-w-full max-h-64 rounded-sm mb-3 object-contain"
          />
        )}

        {sanitizedContent ? (
          <div
            className="feed-article-content text-xs text-text-secondary leading-relaxed max-w-full overflow-hidden break-words [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-sm [&_a]:text-blue-400 [&_a]:underline [&_a:hover]:text-blue-300 [&_a]:break-all [&_pre]:bg-surface-2 [&_pre]:p-2 [&_pre]:rounded-sm [&_pre]:overflow-x-auto [&_pre]:text-[11px] [&_pre]:max-w-full [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:rounded-sm [&_code]:text-[11px] [&_code]:break-all [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-tertiary [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-2 [&_li]:mb-0.5 [&_hr]:border-border [&_hr]:my-3 [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold"
            dangerouslySetInnerHTML={{ __html: sanitizedContent }}
          />
        ) : item.link ? (
          <div className="text-center py-8">
            <p className="text-xs text-text-tertiary mb-2">No article content available</p>
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 underline"
            >
              Open in browser
            </a>
          </div>
        ) : null}

        {/* HN comments */}
        {hnItemId && <HNComments itemId={hnItemId} />}
      </div>
    </div>
  )
}
