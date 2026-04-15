import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import type { DbChatMessage, EncryptedFile } from '@/matrix/types'
import { formatDate } from '@/utils/date'
import { mxcToThumbnail, mxcToHttp, getUrlPreview, type UrlPreview } from '@/matrix/api'
import { decryptAttachment } from '@/matrix/decrypt-media'
import { diffWords } from 'diff'
import DOMPurify from 'dompurify'
import { Reply, SmilePlus } from 'lucide-react'
import clsx from 'clsx'

// --- Markdown / HTML rendering ---

// Lightweight markdown → HTML for plain-text chat messages
function markdownToHtml(text: string): string {
  // Check if the text has any markdown-like syntax at all — skip processing for plain messages
  if (!/[*_`~#>\-\[]|^\d+\.\s/m.test(text)) return ''

  let html = text

  // Fenced code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;').trimEnd()}</code></pre>`,
  )

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, (_m, code) =>
    `<code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`,
  )

  // Bold + italic (***text*** or ___text___)
  html = html.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>')
  html = html.replace(/_{3}(.+?)_{3}/g, '<strong><em>$1</em></strong>')

  // Bold (**text** or __text__)
  html = html.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>')
  html = html.replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>')

  // Italic (*text* or _text_) — avoid matching mid-word underscores
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>')

  // Strikethrough (~~text~~)
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')

  // Headings (# ... at start of line) — only h1-h3
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Blockquote (> ...)
  html = html.replace(/^&gt; ?(.+)$/gm, '<blockquote>$1</blockquote>')
  html = html.replace(/^> ?(.+)$/gm, '<blockquote>$1</blockquote>')

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  // If nothing changed, the text had no actual markdown
  if (html === text) return ''

  return html
}

// Sanitize HTML (Matrix formatted_body or markdown-converted) for safe rendering
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'b', 'i', 'em', 'strong', 'del', 's', 'u', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'br', 'p', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'sup', 'sub',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'mx-reply',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'data-mx-maths', 'class'],
  ALLOW_DATA_ATTR: false,
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG)
}

// Rendered markdown/HTML message body
function FormattedBody({ body, formattedBody }: { body: string; formattedBody?: string }) {
  const html = useMemo(() => {
    if (formattedBody) {
      // Matrix HTML — strip <mx-reply> blocks (quote context already shown separately)
      // Strip bridge sender prefix (e.g. <strong data-mx-profile-fallback>name: </strong>)
      let cleaned = formattedBody
        .replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '')
        .replace(/<strong[^>]*data-mx-profile-fallback[^>]*>[^<]*<\/strong>/gi, '')
      // Linkify bare URLs not already inside <a> tags
      cleaned = cleaned.replace(
        /(^|[^"'>])(https?:\/\/[^\s<>"')\]]+)/g,
        (_, prefix, url) => `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
      )
      return sanitizeHtml(cleaned)
    }
    // Try markdown conversion
    const md = markdownToHtml(body)
    if (md) return sanitizeHtml(md)
    return ''
  }, [body, formattedBody])

  if (!html) {
    // Plain text — use the existing Linkified renderer
    return <p className="text-sm text-text-primary whitespace-pre-wrap break-words"><Linkified text={body} /></p>
  }

  return (
    <div
      className="chat-formatted-body text-sm text-text-primary whitespace-pre-wrap break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// --- Emoji Picker ---

const EMOJI_GRID = [
  '\u{1F600}', '\u{1F602}', '\u{1F972}', '\u2764\uFE0F', '\u{1F525}', '\u{1F44C}', '\u{1F44E}', '\u{1F44F}',
  '\u{1F64F}', '\u{1F932}', '\u{1F914}', '\u{1F62E}', '\u{1F622}', '\u{1F621}', '\u{1F389}', '\u2705',
  '\u{1F440}', '\u{1F4AF}', '\u{1F64C}', '\u{1F60A}', '\u{1F91D}', '\u{1F4AA}', '\u{1F605}', '\u{1FAE1}',
]

function EmojiButton({ onSelect }: { onSelect: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="p-1 text-text-tertiary hover:text-text-primary"
        title="React"
      >
        <SmilePlus size={12} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 bg-surface-1 border border-border rounded-sm shadow-lg p-1.5 grid grid-cols-8 gap-0.5 w-[200px]">
          {EMOJI_GRID.map((emoji) => (
            <button
              key={emoji}
              onClick={() => { onSelect(emoji); setOpen(false) }}
              className="h-6 w-6 flex items-center justify-center text-sm hover:bg-surface-2 rounded-sm"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// URL regex — matches http(s) URLs
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g

function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_REGEX)].map((m) => m[0])
}

function Linkified({ text }: { text: string }) {
  const parts = useMemo(() => {
    const result: { text: string; isUrl: boolean }[] = []
    let lastIndex = 0
    for (const match of text.matchAll(URL_REGEX)) {
      if (match.index > lastIndex) {
        result.push({ text: text.slice(lastIndex, match.index), isUrl: false })
      }
      result.push({ text: match[0], isUrl: true })
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex), isUrl: false })
    }
    return result
  }, [text])

  if (parts.length === 0) return <>{text}</>

  return (
    <>
      {parts.map((part, i) =>
        part.isUrl ? (
          <a
            key={i}
            href={part.text}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline break-all"
          >
            {part.text}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

// Track whether the homeserver supports URL previews (avoid repeated 404s)
let previewSupported: boolean | null = null

function LinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<UrlPreview | null>(null)

  useEffect(() => {
    if (previewSupported === false) return
    let cancelled = false
    getUrlPreview(url)
      .then((p) => {
        if (cancelled) return
        previewSupported = true
        if (p['og:title'] || p['og:description']) {
          setPreview(p)
        }
      })
      .catch(() => {
        if (!cancelled) previewSupported = false
      })
    return () => { cancelled = true }
  }, [url])

  if (!preview) return null

  const imageUrl = preview['og:image']
    ? preview['og:image'].startsWith('mxc://')
      ? mxcToHttp(preview['og:image'])
      : preview['og:image']
    : undefined

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 flex gap-2 rounded border border-border p-2 hover:bg-surface-1 transition-colors max-w-sm"
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          className="h-14 w-14 rounded-sm object-cover flex-shrink-0"
          loading="lazy"
        />
      )}
      <div className="min-w-0 flex-1">
        {preview['og:title'] && (
          <p className="text-xs font-medium text-text-primary truncate">
            {preview['og:title']}
          </p>
        )}
        {preview['og:description'] && (
          <p className="text-[11px] text-text-tertiary line-clamp-2">
            {preview['og:description']}
          </p>
        )}
        <p className="text-[10px] text-text-tertiary truncate mt-0.5">
          {new URL(url).hostname}
        </p>
      </div>
    </a>
  )
}

// Renders an image from either plain mxc:// or encrypted file
function EncryptedImage({ mediaUrl, encryptedFile, alt, onClick }: { mediaUrl?: string; encryptedFile?: EncryptedFile; alt: string; onClick?: (src: string) => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!encryptedFile) return
    let revoked = false
    decryptAttachment(encryptedFile)
      .then((blob) => {
        if (!revoked) setBlobUrl(URL.createObjectURL(blob))
      })
      .catch(() => {})
    return () => {
      revoked = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [encryptedFile?.url])

  // Prefer decrypted blob over plain mxc:// (encrypted rooms serve encrypted blobs at mxc URLs)
  const src = blobUrl ?? (mediaUrl && !encryptedFile ? mxcToHttp(mediaUrl) : null)
  if (!src) return <span className="text-sm text-text-secondary italic">[Image: {alt}]</span>

  return (
    <img
      src={src}
      alt={alt}
      className="max-w-xs max-h-60 rounded-sm cursor-pointer"
      loading="lazy"
      onClick={() => onClick?.(src)}
    />
  )
}

// Renders a file link from either plain mxc:// or encrypted file
function EncryptedFileLink({ mediaUrl, encryptedFile, label, mimeType }: { mediaUrl?: string; encryptedFile?: EncryptedFile; label: string; mimeType?: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!encryptedFile) return
    let revoked = false
    decryptAttachment(encryptedFile)
      .then((blob) => {
        if (!revoked) setBlobUrl(URL.createObjectURL(blob))
      })
      .catch(() => {})
    return () => {
      revoked = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [encryptedFile?.url])

  const href = blobUrl ?? (mediaUrl && !encryptedFile ? (mxcToHttp(mediaUrl) ?? '#') : '#')
  // Derive a filename from MIME type when body is empty (e.g. "application/zip" → "file.zip")
  const MIME_EXT: Record<string, string> = {
    'application/zip': '.zip', 'application/pdf': '.pdf', 'application/json': '.json',
    'application/javascript': '.js', 'text/plain': '.txt', 'text/html': '.html',
    'text/csv': '.csv', 'application/xml': '.xml',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'video/webm': '.webm',
  }
  const ext = mimeType ? (MIME_EXT[mimeType] ?? ('.' + mimeType.split('/')[1])) : ''
  const filename = label || (ext ? `file${ext}` : 'attachment')
  const displayLabel = label || (mimeType ? `${mimeType.split('/')[1]}${ext}` : 'attachment')
  if (!blobUrl && (!mediaUrl || encryptedFile)) return <span className="text-sm text-text-secondary italic">📎 {displayLabel}</span>

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm text-text-secondary underline" download={filename}>
      📎 {displayLabel}
    </a>
  )
}

// Renders a video from either plain mxc:// or encrypted file
function EncryptedVideo({ mediaUrl, encryptedFile, alt, onClick }: { mediaUrl?: string; encryptedFile?: EncryptedFile; alt: string; onClick?: (src: string) => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!encryptedFile) return
    let revoked = false
    decryptAttachment(encryptedFile)
      .then((blob) => {
        if (!revoked) setBlobUrl(URL.createObjectURL(blob))
      })
      .catch(() => {})
    return () => {
      revoked = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [encryptedFile?.url])

  const src = blobUrl ?? (mediaUrl && !encryptedFile ? mxcToHttp(mediaUrl) : null)
  if (!src) return <span className="text-sm text-text-secondary italic">[Video: {alt}]</span>

  return (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      className="max-w-xs max-h-60 rounded-sm"
      onClick={(e) => {
        if (onClick) {
          e.preventDefault()
          onClick(src)
        }
      }}
    />
  )
}

// Renders an audio player from either plain mxc:// or encrypted file.
// Uses Web Audio API for playback because Chrome can't play OGG blob URLs via HTMLAudioElement.
function AudioPlayer({ mediaUrl, encryptedFile, duration, waveform, isVoiceNote }: {
  mediaUrl?: string
  encryptedFile?: EncryptedFile
  duration?: number
  waveform?: number[]
  isVoiceNote?: boolean
}) {
  const [audioData, setAudioData] = useState<ArrayBuffer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [totalDuration, setTotalDuration] = useState(duration ? duration / 1000 : 0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<{ ctx: AudioContext; source: AudioBufferSourceNode; startedAt: number; offset: number } | null>(null)
  const rafRef = useRef<number>(0)

  // Fetch/decrypt audio data
  useEffect(() => {
    let cancelled = false
    if (encryptedFile) {
      decryptAttachment(encryptedFile)
        .then((blob) => blob.arrayBuffer())
        .then((buf) => { if (!cancelled) setAudioData(buf) })
        .catch(() => {})
    } else if (mediaUrl) {
      const url = mxcToHttp(mediaUrl)
      if (url) fetch(url).then((r) => r.arrayBuffer()).then((buf) => { if (!cancelled) setAudioData(buf) }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [encryptedFile?.url, mediaUrl])

  // Cleanup on unmount
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current)
    if (ctxRef.current) {
      ctxRef.current.source.stop()
      ctxRef.current.ctx.close()
      ctxRef.current = null
    }
  }, [])

  const toggle = async () => {
    if (!audioData) return

    if (playing && ctxRef.current) {
      // Pause: record position and stop
      const elapsed = ctxRef.current.ctx.currentTime - ctxRef.current.startedAt + ctxRef.current.offset
      ctxRef.current.source.stop()
      ctxRef.current.ctx.close()
      ctxRef.current = null
      cancelAnimationFrame(rafRef.current)
      setCurrentTime(elapsed)
      setPlaying(false)
      return
    }

    // Play from current offset
    const ctx = new AudioContext()
    try {
      const buffer = await ctx.decodeAudioData(audioData.slice(0))
      if (!totalDuration || totalDuration <= 0) setTotalDuration(buffer.duration)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      const offset = currentTime
      source.start(0, offset)
      ctxRef.current = { ctx, source, startedAt: ctx.currentTime, offset }
      setPlaying(true)

      // Track progress
      const tick = () => {
        if (!ctxRef.current) return
        const elapsed = ctxRef.current.ctx.currentTime - ctxRef.current.startedAt + offset
        setCurrentTime(elapsed)
        if (elapsed < buffer.duration) {
          rafRef.current = requestAnimationFrame(tick)
        }
      }
      rafRef.current = requestAnimationFrame(tick)

      source.onended = () => {
        cancelAnimationFrame(rafRef.current)
        if (ctxRef.current) {
          ctxRef.current.ctx.close()
          ctxRef.current = null
        }
        setPlaying(false)
        setCurrentTime(0)
      }
    } catch {
      ctx.close()
    }
  }

  // Draw waveform
  const drawStateRef = useRef({ currentTime: 0, totalDuration: 0 })
  drawStateRef.current = { currentTime, totalDuration }

  const drawWaveform = useMemo(() => {
    if (!waveform) return undefined
    return (canvas: HTMLCanvasElement) => {
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      if (w === 0 || h === 0) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)

      const maxVal = Math.max(...waveform, 1)
      const barCount = Math.min(waveform.length, 48)
      const step = waveform.length / barCount
      const barW = Math.max(1.5, (w - barCount) / barCount)
      const gap = (w - barW * barCount) / (barCount - 1 || 1)
      const { currentTime: ct, totalDuration: td } = drawStateRef.current
      const progress = td > 0 ? ct / td : 0
      const styles = getComputedStyle(canvas)
      const activeColor = styles.getPropertyValue('--text-secondary').trim() || '#a0a0a0'
      const inactiveColor = styles.getPropertyValue('--border').trim() || '#333'

      ctx.clearRect(0, 0, w, h)
      for (let i = 0; i < barCount; i++) {
        const val = waveform[Math.floor(i * step)]!
        const barH = Math.max(2, (val / maxVal) * h * 0.85)
        const x = i * (barW + gap)
        const y = (h - barH) / 2
        const barProgress = (i + 0.5) / barCount
        ctx.fillStyle = barProgress <= progress ? activeColor : inactiveColor
        ctx.beginPath()
        ctx.roundRect(x, y, barW, barH, 1)
        ctx.fill()
      }
    }
  }, [waveform])

  useEffect(() => {
    if (drawWaveform && canvasRef.current) drawWaveform(canvasRef.current)
  }, [drawWaveform, currentTime, totalDuration])

  useEffect(() => {
    if (!drawWaveform || !canvasRef.current) return
    const canvas = canvasRef.current
    const ro = new ResizeObserver(() => drawWaveform(canvas))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [drawWaveform])

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  if (!audioData && !encryptedFile && !mediaUrl) return <span className="text-sm text-text-secondary italic">[{isVoiceNote ? 'Voice message' : 'Audio'}]</span>

  return (
    <div className="flex items-center gap-2 py-1 max-w-[260px]">
      <button
        onClick={toggle}
        disabled={!audioData}
        className="flex-shrink-0 h-8 w-8 rounded-full bg-surface-2 hover:bg-surface-3 flex items-center justify-center transition-colors disabled:opacity-40"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className="text-text-primary">
            <rect x="3" y="2" width="3" height="10" rx="0.5" />
            <rect x="8" y="2" width="3" height="10" rx="0.5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className="text-text-primary ml-0.5">
            <path d="M3 1.5v11l9-5.5z" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        {waveform && waveform.length > 0 ? (
          <canvas ref={canvasRef} className="w-full h-6" style={{ display: 'block' }} />
        ) : (
          <div className="relative h-1 bg-surface-2 rounded-full overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-text-secondary rounded-full transition-[width] duration-100"
              style={{ width: totalDuration > 0 ? `${(currentTime / totalDuration) * 100}%` : '0%' }}
            />
          </div>
        )}
        <span className="text-[10px] text-text-tertiary mt-0.5 block">
          {playing || currentTime > 0
            ? formatTime(currentTime)
            : totalDuration > 0
              ? formatTime(totalDuration)
              : '0:00'}
        </span>
      </div>
    </div>
  )
}

function EditDiff({ originalBody, newBody }: { originalBody: string; newBody: string }) {
  const parts = useMemo(() => diffWords(originalBody, newBody), [originalBody, newBody])
  return (
    <div className="text-sm whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        part.removed ? (
          <span key={i} className="text-red-400/70 line-through">{part.value}</span>
        ) : part.added ? (
          <span key={i} className="text-green-400">{part.value}</span>
        ) : (
          <span key={i} className="text-text-primary">{part.value}</span>
        ),
      )}
      <span className="text-[10px] text-text-tertiary ml-1">(edited)</span>
    </div>
  )
}

export interface ReadReceiptEntry {
  userId: string
  displayName?: string
  avatar?: string
  ts: number
}

interface ChatMessageBubbleProps {
  message: DbChatMessage
  isOwn: boolean
  showSender: boolean // false when same sender as previous message
  receipts?: ReadReceiptEntry[]
  onImageClick?: (src: string) => void
  onReply?: (msg: DbChatMessage) => void
  onReact?: (msg: DbChatMessage, emoji: string) => void
}

export const ChatMessageBubble = memo(function ChatMessageBubble({ message, isOwn, showSender, receipts, onImageClick, onReply, onReact }: ChatMessageBubbleProps) {
  const avatarUrl = message.senderAvatar ? mxcToThumbnail(message.senderAvatar, 24, 24) : undefined
  // Strip bridge sender prefix (e.g. "anko: message" → "message") when it matches the display name
  const displayBody = useMemo(() => {
    const name = message.senderName
    if (name && message.body.startsWith(name + ': ')) {
      return message.body.slice(name.length + 2)
    }
    return message.body
  }, [message.body, message.senderName])
  const urls = useMemo(
    () => (message.type === 'text' ? extractUrls(displayBody) : []),
    [displayBody, message.type],
  )

  // Swipe-to-reply (mobile)
  const [swipeX, setSwipeX] = useState(0)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const isSwipingHorizontal = useRef<boolean | null>(null)

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]!.clientX
    touchStartY.current = e.touches[0]!.clientY
    isSwipingHorizontal.current = null
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = e.touches[0]!.clientX - touchStartX.current
    const dy = e.touches[0]!.clientY - touchStartY.current
    // Lock direction after initial movement
    if (isSwipingHorizontal.current === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      isSwipingHorizontal.current = Math.abs(dx) > Math.abs(dy)
    }
    if (isSwipingHorizontal.current) {
      setSwipeX(Math.max(0, Math.min(80, dx)))
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (swipeX > 50) onReply?.(message)
    setSwipeX(0)
    isSwipingHorizontal.current = null
  }, [swipeX, onReply, message])

  const handleReactionClick = useCallback((emoji: string) => {
    onReact?.(message, emoji)
  }, [onReact, message])

  return (
    <div className={clsx('relative', showSender ? 'mt-3' : 'mt-0.5')}>
      {/* Swipe reply indicator */}
      {swipeX > 0 && (
        <div
          className="absolute left-1 top-1/2 -translate-y-1/2 text-text-tertiary transition-opacity"
          style={{ opacity: Math.min(1, swipeX / 50) }}
        >
          <Reply size={16} />
        </div>
      )}
      <div
        className="flex gap-2 px-3 group relative min-w-0 hover:bg-surface-1 transition-colors duration-fast"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: swipeX === 0 ? 'transform 0.2s' : 'none',
        }}
      >
      {/* Avatar gutter */}
      <div className="w-6 flex-shrink-0">
        {showSender && (
          avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-6 w-6 rounded-full object-cover mt-0.5" />
          ) : (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-text-tertiary mt-0.5">
              {message.senderName.charAt(0).toUpperCase()}
            </div>
          )
        )}
      </div>

      {/* Hover actions — desktop only */}
      <div className="absolute -top-3 right-2 hidden group-hover:flex items-center gap-0.5 bg-surface-1 border border-border rounded-sm shadow-sm px-0.5 py-0.5 z-10">
        <button onClick={() => onReply?.(message)} className="p-1 text-text-tertiary hover:text-text-primary" title="Reply">
          <Reply size={12} />
        </button>
        <EmojiButton onSelect={(emoji) => onReact?.(message, emoji)} />
      </div>

      {/* Message content */}
      <div className="min-w-0 flex-1 relative">
        {showSender && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className={clsx('text-xs font-medium', isOwn ? 'text-text-tertiary' : 'text-text-secondary')}>
              {isOwn ? 'You' : message.senderName}
            </span>
            <span className="text-[10px] text-text-tertiary">
              {formatDate(message.timestamp)}
            </span>
          </div>
        )}

        {/* Reply context */}
        {message.replyTo && (
          <div className="mb-1 border-l-2 border-border-strong pl-2 text-xs text-text-tertiary truncate">
            {message.replyTo.body || 'Original message'}
          </div>
        )}

        {/* Body */}
        {message.isDeleted ? (
          <div className="text-sm">
            <span className="text-red-400/70 line-through">{message.body || 'Message deleted'}</span>
            {message.deletedBy && (
              <span className="text-[10px] text-text-tertiary ml-1">
                (deleted by {message.deletedBy.split(':')[0]?.slice(1)})
              </span>
            )}
          </div>
        ) : message.type === 'image' ? (
          <div className="mt-1">
            <EncryptedImage mediaUrl={message.mediaUrl} encryptedFile={message.encryptedFile} alt={message.body} onClick={onImageClick} />
            {displayBody && !/\.(jpe?g|png|gif|webp|heic|heif|svg|bmp|tiff?)$/i.test(displayBody) && (
              <p className="text-sm text-text-secondary mt-1"><Linkified text={displayBody} /></p>
            )}
          </div>
        ) : message.type === 'video' ? (
          <div className="mt-1">
            <EncryptedVideo mediaUrl={message.mediaUrl} encryptedFile={message.encryptedFile} alt={displayBody} onClick={onImageClick} />
            {displayBody && !/\.(mp4|mov|avi|webm|mkv|m4v|3gp|ogv)$/i.test(displayBody) && (
              <p className="text-sm text-text-secondary mt-1"><Linkified text={displayBody} /></p>
            )}
          </div>
        ) : message.type === 'file' ? (
          <EncryptedFileLink mediaUrl={message.mediaUrl} encryptedFile={message.encryptedFile} label={displayBody} mimeType={message.mediaMimeType} />
        ) : message.type === 'audio' ? (
          <AudioPlayer
            mediaUrl={message.mediaUrl}
            encryptedFile={message.encryptedFile}
            duration={message.audioDuration}
            waveform={message.audioWaveform}
            isVoiceNote={message.isVoiceNote}
          />
        ) : message.type === 'notice' ? (
          <p className="text-sm text-text-tertiary italic"><Linkified text={displayBody} /></p>
        ) : message.type === 'emote' ? (
          <p className="text-sm text-text-secondary italic">* {message.senderName} <Linkified text={displayBody} /></p>
        ) : message.isEdited && message.originalBody ? (
          <EditDiff originalBody={message.originalBody} newBody={displayBody} />
        ) : (
          <FormattedBody body={displayBody} formattedBody={message.formattedBody} />
        )}

        {/* URL previews (first URL only to avoid clutter) */}
        {urls.length > 0 && !message.isDeleted && <LinkPreview url={urls[0]!} />}

        {/* Edited indicator (when no originalBody available for diff) */}
        {message.isEdited && !message.originalBody && !message.isDeleted && (
          <span className="text-[10px] text-text-tertiary">(edited)</span>
        )}

        {/* Send failure */}
        {message.sendFailed && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[10px] text-red-400">Failed to send</span>
            <span className="text-[10px] text-text-tertiary" title={message.sendFailed}>— {message.sendFailed.slice(0, 80)}</span>
          </div>
        )}

        {/* Pending indicator for local echo */}
        {message.id.startsWith('~') && !message.sendFailed && (
          <span className="text-[10px] text-text-tertiary">Sending…</span>
        )}

        {/* Reactions */}
        {message.reactions && Object.keys(message.reactions).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {Object.entries(message.reactions).map(([emoji, senders]) => (
              <button
                key={emoji}
                onClick={() => handleReactionClick(emoji)}
                className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-xs hover:bg-surface-3 transition-colors cursor-pointer"
                title={senders.join(', ')}
              >
                {emoji} <span className="text-text-tertiary">{senders.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Read receipts */}
        {receipts && receipts.length > 0 && (
          <div className="absolute bottom-0 right-0 inline-flex items-center gap-0.5">
            {receipts.slice(0, 5).map((r) => {
              const avatarUrl = r.avatar ? mxcToThumbnail(r.avatar, 16, 16) : undefined
              return (
                <div
                  key={r.userId}
                  className="h-4 w-4 rounded-full overflow-hidden flex-shrink-0"
                  title={`${r.displayName ?? r.userId} \u2022 ${formatDate(r.ts)}`}
                >
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-surface-2 text-[8px] font-medium text-text-tertiary">
                      {(r.displayName ?? r.userId).charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
              )
            })}
            {receipts.length > 5 && (
              <span className="text-[9px] text-text-tertiary ml-0.5">+{receipts.length - 5}</span>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  )
})
