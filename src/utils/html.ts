import DOMPurify from 'dompurify'

const textarea = document.createElement('textarea')

/** Decode HTML entities like `&#39;` → `'` */
export function decodeEntities(text: string): string {
  textarea.innerHTML = text
  return textarea.value
}

const URL_RE = /(https?:\/\/[^\s<>"')]+)/g

/**
 * Sanitize an HTML or plaintext snippet for read-only display, with raw URLs
 * auto-linked into `<a>` tags. Anchors open in a new tab. Suitable for things
 * like calendar event descriptions where the source could be either format.
 */
export function sanitizeAndLinkify(input: string): string {
  const sanitized = DOMPurify.sanitize(input, {
    ALLOWED_TAGS: ['a', 'b', 'i', 'u', 'strong', 'em', 'br', 'p', 'span', 'div', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href'],
  })
  const wrapper = document.createElement('div')
  wrapper.innerHTML = sanitized
  const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) {
    if (n.parentElement?.closest('a')) continue
    if (URL_RE.test((n as Text).data)) textNodes.push(n as Text)
    URL_RE.lastIndex = 0
  }
  for (const t of textNodes) {
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    URL_RE.lastIndex = 0
    while ((m = URL_RE.exec(t.data))) {
      if (m.index > last) frag.appendChild(document.createTextNode(t.data.slice(last, m.index)))
      const a = document.createElement('a')
      a.href = m[0]
      a.textContent = m[0]
      frag.appendChild(a)
      last = URL_RE.lastIndex
    }
    if (last < t.data.length) frag.appendChild(document.createTextNode(t.data.slice(last)))
    t.parentNode?.replaceChild(frag, t)
  }
  // All anchors (sanitized + autolinked) open in a new tab.
  wrapper.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
  return wrapper.innerHTML
}
