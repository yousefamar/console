import { useEffect, useCallback, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { useInboxStore } from '@/store/inbox'
import { useComposeStore } from '@/store/compose'
import { useUiStore } from '@/store/ui'
import type { DbMessage, AttachmentMeta, SendAsAlias } from '@/gmail/types'
import { ContactAutocomplete } from './ContactAutocomplete'
import { getAttachmentBlob } from '@/utils/attachment-cache'
import { formatFileSize } from '@/utils/attachment-cache'
import type { ComposeAttachment } from '@/store/compose'
import { Paperclip, X, ChevronDown } from 'lucide-react'
import { db, getMeta } from '@/db'
import { parseAddressList } from '@/utils/email'

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Cached alias loading — avoids querying 500 messages on every ComposeEditor mount
let aliasCache: SendAsAlias[] | null = null
let aliasCacheTime = 0
const ALIAS_CACHE_TTL = 10 * 60_000

async function loadCachedAliases(): Promise<SendAsAlias[]> {
  if (aliasCache && Date.now() - aliasCacheTime < ALIAS_CACHE_TTL) return aliasCache

  const raw = await getMeta('sendAsAliases')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as SendAsAlias[]
    if (parsed.length <= 1) { aliasCache = parsed; aliasCacheTime = Date.now(); return parsed }

    const recency = new Map<string, number>()
    const msgs = await db.messages.orderBy('date').reverse().limit(500).toArray()
    for (const msg of msgs) {
      const recipients = [msg.to, msg.cc].filter(Boolean).join(', ').toLowerCase()
      for (const alias of parsed) {
        const email = alias.email.toLowerCase()
        if (!recency.has(email) && recipients.includes(email)) {
          recency.set(email, msg.date)
        }
      }
      if (recency.size >= parsed.length) break
    }

    parsed.sort((a, b) => (recency.get(b.email.toLowerCase()) ?? 0) - (recency.get(a.email.toLowerCase()) ?? 0))
    aliasCache = parsed
    aliasCacheTime = Date.now()
    return parsed
  } catch { return [] }
}

interface ComposeEditorProps {
  mode: 'reply' | 'replyAll' | 'forward' | 'compose'
  lastMessage?: DbMessage | null
  onClose: () => void
}

/** Pick the best send-as alias for the given message context */
export function pickFromAddress(
  aliases: SendAsAlias[],
  lastMessage: DbMessage | null | undefined,
  userEmail: string,
): string {
  if (!aliases.length) return userEmail
  if (!lastMessage) return aliases.find((a) => a.isDefault)?.email ?? aliases[0]!.email

  const aliasEmails = aliases.map((a) => a.email.toLowerCase())

  // Collect all recipient addresses from the message being replied to
  const allRecipients = [lastMessage.to, lastMessage.cc].filter(Boolean).join(', ')
  const recipientEmails = parseAddressList(allRecipients).map((r) => r.email.toLowerCase())

  // 1. Exact match: one of my aliases was in To/Cc
  const exactMatch = aliasEmails.find((a) => recipientEmails.includes(a))
  if (exactMatch) return exactMatch

  // 2. Domain match: same domain as one of the recipients
  const recipientDomains = recipientEmails.map((e) => e.split('@')[1])
  const domainMatch = aliases.find((a) => {
    const domain = a.email.toLowerCase().split('@')[1]
    return recipientDomains.includes(domain)
  })
  if (domainMatch) return domainMatch.email

  // 3. Default alias
  return aliases.find((a) => a.isDefault)?.email ?? aliases[0]!.email
}

export function ComposeEditor({ mode, lastMessage, onClose }: ComposeEditorProps) {
  const sendReply = useInboxStore((s) => s.sendReply)
  const from = useComposeStore((s) => s.from)
  const to = useComposeStore((s) => s.to)
  const cc = useComposeStore((s) => s.cc)
  const subject = useComposeStore((s) => s.subject)
  const bodyHtml = useComposeStore((s) => s.bodyHtml)
  const quotedHtml = useComposeStore((s) => s.quotedHtml)
  const attachments = useComposeStore((s) => s.attachments)
  const setFrom = useComposeStore((s) => s.setFrom)
  const setTo = useComposeStore((s) => s.setTo)
  const setCc = useComposeStore((s) => s.setCc)
  const setSubject = useComposeStore((s) => s.setSubject)
  const setBody = useComposeStore((s) => s.setBody)
  const setQuotedHtml = useComposeStore((s) => s.setQuotedHtml)
  const addAttachment = useComposeStore((s) => s.addAttachment)
  const addAttachmentFromData = useComposeStore((s) => s.addAttachmentFromData)
  const removeAttachment = useComposeStore((s) => s.removeAttachment)
  const reset = useComposeStore((s) => s.reset)
  const userEmail = useUiStore((s) => s.userEmail)
  const toRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const initRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  const [aliases, setAliases] = useState<SendAsAlias[]>([])
  const [showFromPicker, setShowFromPicker] = useState(false)

  // Load send-as aliases (cached — expensive recency sort only runs once)
  useEffect(() => {
    loadCachedAliases().then((a) => { if (a.length) setAliases(a) })
  }, [])

  // Set the best "from" address whenever aliases load
  useEffect(() => {
    if (aliases.length > 0) {
      setFrom(pickFromAddress(aliases, lastMessage, userEmail))
    }
  }, [aliases]) // eslint-disable-line react-hooks/exhaustive-deps

  // Derive initial values from mode and last message
  useEffect(() => {
    const key = `${mode}:${lastMessage?.id ?? 'new'}`
    if (initRef.current === key) return
    initRef.current = key

    if (!lastMessage && mode !== 'compose') return

    if (mode === 'reply' && lastMessage) {
      setTo(lastMessage.fromEmail === userEmail ? lastMessage.to : `${lastMessage.from} <${lastMessage.fromEmail}>`)
      setSubject(
        lastMessage.subject.startsWith('Re:') ? lastMessage.subject : `Re: ${lastMessage.subject}`,
      )
    } else if (mode === 'replyAll' && lastMessage) {
      setTo(`${lastMessage.from} <${lastMessage.fromEmail}>`)
      // Filter out whichever alias we're sending from
      const fromEmail = from || userEmail
      const allRecipients = [lastMessage.to, lastMessage.cc].filter(Boolean).join(', ')
      const aliasEmails = aliases.map((a) => a.email.toLowerCase())
      const filtered = allRecipients
        .split(',')
        .map((s) => s.trim())
        .filter((s) => {
          const lower = s.toLowerCase()
          return !lower.includes(fromEmail.toLowerCase()) && !aliasEmails.some((a) => lower.includes(a))
        })
        .join(', ')
      setCc(filtered)
      setSubject(
        lastMessage.subject.startsWith('Re:') ? lastMessage.subject : `Re: ${lastMessage.subject}`,
      )
    } else if (mode === 'forward' && lastMessage) {
      setTo('')
      setSubject(
        lastMessage.subject.startsWith('Fwd:') ? lastMessage.subject : `Fwd: ${lastMessage.subject}`,
      )

      // Carry over attachments (all at once to avoid races)
      const nonInline = (lastMessage.attachments ?? []).filter((a: AttachmentMeta) => !a.contentId)
      if (nonInline.length > 0) {
        loadForwardAttachments(lastMessage.id, nonInline).then((atts) => {
          if (atts.length > 0) addAttachmentFromData(atts)
        })
      }
    }
    if (mode === 'forward' || mode === 'compose') {
      setTimeout(() => toRef.current?.focus(), 100)
    }
  }, [mode, lastMessage?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: 'Write your message...',
      }),
      Markdown.configure({
        html: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-editor',
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = e.storage.markdown.getMarkdown()
      const html = e.getHTML()
      setBody(md, html)
    },
    autofocus: mode === 'reply' || mode === 'replyAll' ? 'end' : false,
    onCreate: () => {
      if (!lastMessage) return
      const originalBody = lastMessage.bodyHtml
        || (lastMessage.bodyText ? `<pre>${esc(lastMessage.bodyText)}</pre>` : '')
      if (!originalBody) return

      // Gmail-style date: "{locale date} at {locale time}"
      const d = new Date(lastMessage.date)
      const datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      const timePart = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      const msgDate = `${datePart} at ${timePart}`

      if (mode === 'forward') {
        const quoted =
          `<br><div class="gmail_quote">` +
          `<div dir="ltr" style="font-size:small;color:#222">---------- Forwarded message ---------<br>` +
          `<b>From:</b> ${esc(lastMessage.from)} &lt;${esc(lastMessage.fromEmail)}&gt;<br>` +
          `<b>Date:</b> ${msgDate}<br>` +
          `<b>Subject:</b> ${esc(lastMessage.subject)}<br>` +
          `<b>To:</b> ${esc(lastMessage.to)}<br></div>` +
          `<br>` +
          originalBody +
          `</div>`
        setQuotedHtml(quoted)
      } else if (mode === 'reply' || mode === 'replyAll') {
        const quoted =
          `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On ${msgDate} ${esc(lastMessage.from)} &lt;${esc(lastMessage.fromEmail)}&gt; wrote:<br></div>` +
          `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
          originalBody +
          `</blockquote></div>`
        setQuotedHtml(quoted)
      }
    },
  })

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return
    sendingRef.current = true

    try {
      // Read HTML directly from editor to avoid stale compose state
      const editorHtml = editor?.getHTML() ?? bodyHtml
      // Wrap user content in a div, then append quoted content outside it
      // This ensures Gmail treats them as separate blocks (user text above the ⋯ expander)
      let html = quotedHtml
        ? `<div dir="ltr">${editorHtml}</div>${quotedHtml}`
        : editorHtml
      if (!html && !to) return

      const inReplyTo = lastMessage?.headers['message-id'] ?? undefined
      const references = lastMessage?.headers['references']
        ? `${lastMessage.headers['references']} ${inReplyTo}`
        : inReplyTo

      const sendAttachments = attachments.length > 0
        ? attachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            data: a.data,
          }))
        : undefined

      await sendReply({
        from: from || undefined,
        to: to,
        cc: cc || undefined,
        subject: subject,
        html,
        inReplyTo,
        references,
        attachments: sendAttachments,
      })

      reset()
      editor?.commands.clearContent()
      onClose()
    } finally {
      sendingRef.current = false
    }
  }, [from, to, cc, subject, bodyHtml, quotedHtml, attachments, lastMessage, sendReply, editor, onClose, reset])

  // Cmd+Enter to send
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSend()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSend])

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files) return
    for (const file of files) {
      addAttachment(file)
    }
    // Reset so same file can be re-selected
    e.target.value = ''
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const files = e.dataTransfer.files
    for (const file of files) {
      addAttachment(file)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  return (
    <div className="border-t border-border bg-surface-1 animate-slide-up">
      {/* From field (only if multiple aliases) */}
      {aliases.length > 1 && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 relative">
          <span className="text-xs text-text-tertiary w-8">From</span>
          <button
            onClick={() => setShowFromPicker(!showFromPicker)}
            className="flex items-center gap-1 text-sm text-text-primary hover:text-text-secondary transition-colors duration-fast"
          >
            <span>{from || userEmail}</span>
            <ChevronDown size={12} className="text-text-tertiary" />
          </button>
          {showFromPicker && (
            <div className="absolute bottom-full left-12 z-50 mb-0.5 w-72 max-h-64 overflow-y-auto rounded-sm border border-border bg-surface-1 py-1 shadow-lg">
              {aliases.map((alias) => (
                <button
                  key={alias.email}
                  onClick={() => {
                    setFrom(alias.email)
                    setShowFromPicker(false)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors duration-fast hover:bg-surface-2 ${
                    (from || userEmail) === alias.email ? 'text-accent' : 'text-text-primary'
                  }`}
                >
                  <span>{alias.email}</span>
                  {alias.name && <span className="text-text-tertiary text-xs">({alias.name})</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* To / Cc fields */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
        <span className="text-xs text-text-tertiary w-8">To</span>
        <ContactAutocomplete
          value={to}
          onChange={setTo}
          placeholder="recipient@email.com"
          inputRef={toRef}
        />
      </div>
      {(mode === 'replyAll' || mode === 'compose' || cc) && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
          <span className="text-xs text-text-tertiary w-8">Cc</span>
          <ContactAutocomplete
            value={cc}
            onChange={setCc}
            placeholder="cc@email.com"
          />
        </div>
      )}
      {(mode === 'compose' || mode === 'forward') && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
          <span className="text-xs text-text-tertiary w-8">Sub</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
            placeholder="Subject"
          />
        </div>
      )}

      {/* Editor */}
      <div
        className="px-4 py-2 min-h-[100px] max-h-[300px] overflow-y-auto"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <EditorContent editor={editor} />
      </div>

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 py-0.5 text-xs"
            >
              <Paperclip size={10} className="text-text-tertiary" />
              <span className="text-text-secondary truncate max-w-[150px]">{att.filename}</span>
              <span className="text-text-tertiary">({formatFileSize(att.size)})</span>
              <button
                onClick={() => removeAttachment(att.id)}
                className="text-text-tertiary hover:text-destructive transition-colors duration-fast"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSend}
            className="rounded-sm bg-accent px-3 py-1 text-xs font-medium text-white transition-colors duration-fast hover:bg-accent-hover"
          >
            Send
            <span className="ml-1.5 text-white/60">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+↵
            </span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-sm border border-border px-2 py-1 text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors duration-fast"
            title="Attach file"
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
        <button
          onClick={() => {
            reset()
            editor?.commands.clearContent()
            onClose()
          }}
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
        >
          Discard
        </button>
      </div>

    </div>
  )
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function loadForwardAttachments(
  messageId: string,
  attachments: AttachmentMeta[],
): Promise<ComposeAttachment[]> {
  const results = await Promise.all(
    attachments.map(async (att) => {
      const blob = await getAttachmentBlob(messageId, att)
      if (!blob) return null
      const data = await blobToBase64(blob)
      const result: ComposeAttachment = {
        id: crypto.randomUUID(),
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        data,
      }
      return result
    }),
  )
  return results.filter((r): r is ComposeAttachment => r !== null)
}
