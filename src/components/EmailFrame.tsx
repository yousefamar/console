import { useEffect, useRef, useState, useCallback, memo } from 'react'
import { useUiStore } from '@/store/ui'
import { sanitizeHtml, buildDarkModeEmailCss } from '@/utils/email'
import { getCached, updateHeight } from '@/utils/email-cache'

interface EmailFrameProps {
  messageId: string
  html: string
  visible: boolean
}

const DARK_STYLE_ID = 'console-dark-mode'

export const EmailFrame = memo(function EmailFrame({ messageId, html, visible }: EmailFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const emailDarkMode = useUiStore((s) => s.emailDarkMode)
  const darkMode = useUiStore((s) => s.darkMode)
  const applyDark = emailDarkMode && darkMode
  const cached = getCached(messageId)
  const [height, setHeight] = useState(cached?.height ?? 0)
  const loaded = useRef(false)
  const measured = useRef(false)

  const measure = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    try {
      const body = iframe.contentDocument?.body
      if (!body) return
      fitBodyToWidth(iframe)
      const h = body.getBoundingClientRect().height + 16
      if (h > 16) {
        setHeight(h)
        updateHeight(messageId, h)
        measured.current = true
      }
    } catch {
      // Cross-origin, ignore
    }
  }, [messageId])

  // Load iframe content — always use the light URL (we toggle dark via DOM)
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    let fallbackUrl: string | null = null

    if (cached) {
      iframe.src = cached.lightUrl
    } else {
      const sanitized = sanitizeHtml(html)
      // Replace cid: URLs with a transparent pixel to avoid ERR_UNKNOWN_URL_SCHEME console errors.
      // The preload step will later replace these with actual blob URLs in the cached version.
      const withoutCid = sanitized.replace(/cid:[^"'\s)]+/gi, 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==')
      const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="color-scheme" content="only light"><meta name="supported-color-schemes" content="light only"><style>:root{color-scheme:only light}body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.5;word-break:break-word;background:#fff}a{color:#3b82f6}img{max-width:100%;height:auto}blockquote{margin:.5em 0;padding-left:.75em;border-left:2px solid #ccc}</style></head><body>${withoutCid}</body></html>`
      const blob = new Blob([doc], { type: 'text/html' })
      fallbackUrl = URL.createObjectURL(blob)
      iframe.src = fallbackUrl
    }

    const handleLoad = () => {
      if (fallbackUrl) URL.revokeObjectURL(fallbackUrl)
      loaded.current = true
      try {
        const body = iframe.contentDocument?.body
        if (body) {
          body.addEventListener('click', (e) => {
            const anchor = (e.target as Element).closest('a')
            if (anchor) {
              e.preventDefault()
              window.open(anchor.href, '_blank', 'noopener')
            }
            // Return focus to parent so keybindings work
            window.focus()
          })
          // Also catch focus on the iframe itself
          body.addEventListener('focusin', () => {
            window.focus()
          })
        }
      } catch {
        // Cross-origin
      }
      // Apply dark mode if needed after load
      toggleDarkInIframe(iframe, applyDark)
      if (visible) measure()
    }

    iframe.addEventListener('load', handleLoad)
    return () => iframe.removeEventListener('load', handleLoad)
  }, [messageId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle dark mode via DOM injection — no iframe reload
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !loaded.current) return
    toggleDarkInIframe(iframe, applyDark)
  }, [applyDark])

  // Measure when becoming visible
  useEffect(() => {
    if (visible && loaded.current && !measured.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          measure()
        })
      })
    }
  }, [visible, measure])

  // Re-measure (and re-fit width) when iframe size changes — orientation,
  // sidebar toggle, etc.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (loaded.current) measure()
    })
    ro.observe(iframe)
    return () => ro.disconnect()
  }, [measure])

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin allow-popups"
      className="w-full border-none"
      style={{ height: height > 0 ? `${height}px` : '80vh' }}
      title="Email content"
    />
  )
})

const FIT_STYLE_ID = 'console-fit-width'

function fitBodyToWidth(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument
  if (!doc) return
  const iframeW = iframe.clientWidth
  if (iframeW <= 0) return
  // Replace if present so HMR / rule changes take effect on existing iframes.
  doc.getElementById(FIT_STYLE_ID)?.remove()
  const style = doc.createElement('style')
  style.id = FIT_STYLE_ID
  style.textContent = `
    html, body { max-width: 100% !important; overflow-x: hidden !important; }
    body * { max-width: 100% !important; }
    /* Marketing emails use fixed-width <table> for layout. Force linear flow
       so text wraps to the viewport instead of getting clipped. */
    table, tbody, thead, tfoot, tr, td, th {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
    }
    td, th { word-break: break-word; overflow-wrap: anywhere; }
    img, video, iframe { height: auto !important; }
    pre { white-space: pre-wrap !important; word-break: break-word; }
  `
  doc.head.appendChild(style)
}

function toggleDarkInIframe(iframe: HTMLIFrameElement, dark: boolean) {
  try {
    const doc = iframe.contentDocument
    if (!doc) return

    const existing = doc.getElementById(DARK_STYLE_ID)

    if (dark && !existing) {
      const style = doc.createElement('style')
      style.id = DARK_STYLE_ID
      style.textContent = buildDarkModeEmailCss()
      doc.head.appendChild(style)
    } else if (!dark && existing) {
      existing.remove()
    }
  } catch {
    // Cross-origin, ignore
  }
}
