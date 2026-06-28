import { useState, useRef, useCallback, useEffect, memo } from 'react'
import { useChatStore } from '@/store/chat'
import { useGlassesStore } from '@/glasses/store'
import { Send, Paperclip, X } from 'lucide-react'
import { searchEmoji } from '@/utils/emoji-shortcodes'
import { primeRoomMembers, searchRoomMembers, type RoomMember } from '@/matrix/room-members'

interface ChatComposeInputProps {
  roomId: string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build the Matrix `formatted_body` HTML for a message that contains
 *  `@DisplayName` tokens. Only mentions whose `@<displayName>` substring is
 *  still present in the body are wired up — if the user typed @Alice then
 *  deleted it, Alice should not get notified. Returns undefined when no
 *  mentions survive. */
function buildMentionsFormatted(
  body: string,
  mentions: Array<{ displayName: string; userId: string }>,
): { formattedBody: string; activeMentions: Array<{ displayName: string; userId: string }> } | undefined {
  // Filter to mentions actually present in the body as a discrete `@Name` token.
  const active = mentions.filter((m) => {
    const re = new RegExp(`(^|\\s|[.,!?:;])@${escapeRegex(m.displayName)}(?=$|\\s|[.,!?:;])`)
    return re.test(body)
  })
  if (active.length === 0) return undefined
  // Replace tokens left-to-right with anchor tags. Longer names first so
  // "@Alice Smith" wins over a bare "@Alice" mention if both apply.
  const sorted = [...active].sort((a, b) => b.displayName.length - a.displayName.length)
  let html = escapeHtml(body)
  for (const m of sorted) {
    const re = new RegExp(`(^|\\s|[.,!?:;])@${escapeRegex(m.displayName)}(?=$|\\s|[.,!?:;])`, 'g')
    const link = `<a href="https://matrix.to/#/${encodeURIComponent(m.userId)}">@${escapeHtml(m.displayName)}</a>`
    html = html.replace(re, (_match, pre) => `${pre}${link}`)
  }
  return { formattedBody: html, activeMentions: active }
}


export const ChatComposeInput = memo(function ChatComposeInput({ roomId }: ChatComposeInputProps) {
  // Text lives in a ref + the textarea's uncontrolled value, NOT React state.
  // Typing mutates the DOM directly, triggering zero React renders per keystroke
  // (except when hasContent flips or emoji autocomplete is active).
  const textRef = useRef('')
  const [hasContent, setHasContent] = useState(false)
  // Multiple attachments queue. Each carries its file + (for images) an
  // object-URL preview; non-images render a filename chip. Matrix has no
  // multi-image event — sending N images is N sequential m.image events
  // (which is exactly what the Beeper app does under the hood), so the
  // send loop just dispatches each entry in turn.
  const [pendingFiles, setPendingFiles] = useState<{ id: string; file: File; preview: string | null }[]>([])
  const attachIdRef = useRef(0)
  const [emojiQuery, setEmojiQuery] = useState<{ query: string; startIdx: number } | null>(null)
  const [emojiResults, setEmojiResults] = useState<{ shortcode: string; emoji: string }[]>([])
  const [emojiSelectedIdx, setEmojiSelectedIdx] = useState(0)
  // @-mention autocomplete state — parallels the emoji one. Active mention
  // userIds collected here flow into the formatted_body + `m.mentions` on send
  // so receiving Matrix clients (Element, Cinny, the bridges) treat the
  // message as an intentional mention per MSC3952.
  const [mentionQuery, setMentionQuery] = useState<{ query: string; startIdx: number } | null>(null)
  const [mentionResults, setMentionResults] = useState<RoomMember[]>([])
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0)
  // Display-name → userId pairs the user actively inserted via the picker
  // during this compose. Cleared on send/clear. Used to build the formatted
  // body so duplicate display names still link to the right MXID.
  const pendingMentionsRef = useRef<Array<{ displayName: string; userId: string }>>([])
  const sendMessage = useChatStore((s) => s.sendMessage)
  const sendImage = useChatStore((s) => s.sendImage)
  const sendFile = useChatStore((s) => s.sendFile)
  const editMessage = useChatStore((s) => s.editMessage)
  const replyingTo = useChatStore((s) => s.replyingTo)
  const setReplyingTo = useChatStore((s) => s.setReplyingTo)
  const editingMessage = useChatStore((s) => s.editingMessage)
  const setEditingMessage = useChatStore((s) => s.setEditingMessage)
  const sendingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus input when replyingTo changes
  useEffect(() => {
    if (replyingTo) {
      inputRef.current?.focus()
    }
  }, [replyingTo])

  // When the user picks a message to edit (only ones in this room — the store
  // is room-agnostic), pre-fill the textarea with its current body, place the
  // cursor at the end, and focus. Cancelling restores empty state.
  useEffect(() => {
    if (!editingMessage || editingMessage.roomId !== roomId) return
    const body = editingMessage.body
    textRef.current = body
    setHasContent(!!body.trim())
    if (inputRef.current) {
      inputRef.current.value = body
      inputRef.current.style.height = '24px'
      inputRef.current.style.height = Math.min(120, inputRef.current.scrollHeight) + 'px'
      inputRef.current.focus()
      const pos = body.length
      inputRef.current.selectionStart = pos
      inputRef.current.selectionEnd = pos
    }
  }, [editingMessage, roomId])

  const detectEmojiQuery = useCallback((value: string, cursorPos: number) => {
    const textBefore = value.slice(0, cursorPos)
    const colonMatch = textBefore.match(/:([a-z0-9_+-]*)$/)
    if (colonMatch && colonMatch[1] !== undefined && colonMatch.index !== undefined) {
      const query = colonMatch[1]
      const startIdx = colonMatch.index
      if (query.length >= 1) {
        const results = searchEmoji(query)
        setEmojiQuery({ query, startIdx })
        setEmojiResults(results)
        setEmojiSelectedIdx(0)
      } else {
        setEmojiQuery({ query: '', startIdx })
        setEmojiResults([])
      }
    } else {
      setEmojiQuery(null)
      setEmojiResults((prev) => prev.length === 0 ? prev : [])
    }
  }, [])

  // Detect `@<query>` at the cursor — only when the `@` is at the start of
  // input or preceded by whitespace, so typing inside an email like
  // alice@example.com doesn't open the mention picker.
  const detectMentionQuery = useCallback((value: string, cursorPos: number) => {
    const textBefore = value.slice(0, cursorPos)
    const atMatch = textBefore.match(/(?:^|\s)@([^\s@]*)$/)
    if (atMatch && atMatch[1] !== undefined && atMatch.index !== undefined) {
      const query = atMatch[1]
      // Offset of the `@` (atMatch.index points at the whitespace or 0).
      const startIdx = atMatch[0].startsWith('@') ? atMatch.index : atMatch.index + 1
      const results = searchRoomMembers(roomId, query)
      setMentionQuery({ query, startIdx })
      setMentionResults(results)
      setMentionSelectedIdx(0)
    } else {
      setMentionQuery((prev) => prev === null ? prev : null)
      setMentionResults((prev) => prev.length === 0 ? prev : [])
    }
  }, [roomId])

  // Prime the room member list on mount / room switch so the first `@`
  // keystroke isn't a blank dropdown waiting on the network.
  useEffect(() => {
    void primeRoomMembers(roomId).catch(() => {})
    pendingMentionsRef.current = []
  }, [roomId])

  const attachFile = useCallback((file: File) => {
    const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    setPendingFiles((prev) => [...prev, { id: `a${attachIdRef.current++}`, file, preview }])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setPendingFiles((prev) => {
      const hit = prev.find((p) => p.id === id)
      if (hit?.preview) URL.revokeObjectURL(hit.preview)
      return prev.filter((p) => p.id !== id)
    })
  }, [])

  const clearAttachments = useCallback(() => {
    setPendingFiles((prev) => {
      for (const p of prev) if (p.preview) URL.revokeObjectURL(p.preview)
      return []
    })
  }, [])

  // Replace the in-flight `@query` with `@DisplayName ` and record the
  // mention. The trailing space lets the user keep typing without re-arming
  // the picker on the very next keystroke.
  const selectMention = useCallback((member: RoomMember) => {
    if (!mentionQuery) return
    const cur = textRef.current
    const before = cur.slice(0, mentionQuery.startIdx)
    const after = cur.slice(mentionQuery.startIdx + 1 /* @ */ + mentionQuery.query.length)
    const displayName = member.displayName || (member.userId.split(':')[0] ?? member.userId).slice(1)
    const insertion = `@${displayName} `
    const newText = before + insertion + after
    textRef.current = newText
    if (inputRef.current) {
      inputRef.current.value = newText
      inputRef.current.style.height = '24px'
      inputRef.current.style.height = Math.min(120, inputRef.current.scrollHeight) + 'px'
    }
    setHasContent(!!newText.trim())
    setMentionQuery(null)
    setMentionResults([])
    // Track this mention so the send path can attach it to m.mentions even if
    // there are multiple members with the same display name.
    if (!pendingMentionsRef.current.some((m) => m.userId === member.userId)) {
      pendingMentionsRef.current.push({ displayName, userId: member.userId })
    }
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = mentionQuery.startIdx + insertion.length
        inputRef.current.selectionStart = pos
        inputRef.current.selectionEnd = pos
        inputRef.current.focus()
      }
    })
  }, [mentionQuery])

  const selectEmoji = useCallback((result: { shortcode: string; emoji: string }) => {
    if (!emojiQuery) return
    const cur = textRef.current
    const before = cur.slice(0, emojiQuery.startIdx)
    const after = cur.slice(emojiQuery.startIdx + emojiQuery.query.length + 1) // +1 for the colon
    const newText = before + result.emoji + after
    textRef.current = newText
    if (inputRef.current) {
      inputRef.current.value = newText
      inputRef.current.style.height = '24px'
      inputRef.current.style.height = Math.min(120, inputRef.current.scrollHeight) + 'px'
    }
    setHasContent(!!newText.trim())
    setEmojiQuery(null)
    setEmojiResults([])
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = emojiQuery.startIdx + result.emoji.length
        inputRef.current.selectionStart = pos
        inputRef.current.selectionEnd = pos
        inputRef.current.focus()
      }
    })
  }, [emojiQuery])

  const clearInput = useCallback(() => {
    textRef.current = ''
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.style.height = '24px'
    }
    setHasContent(false)
    setEmojiQuery(null)
    setEmojiResults([])
    setMentionQuery(null)
    setMentionResults([])
    pendingMentionsRef.current = []
    useGlassesStore.getState().setComposerText('chat', '')
  }, [])

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return

    // Edit mode short-circuits: no image attach, no reply chaining — just
    // submit the m.replace and clear back to fresh state.
    if (editingMessage && editingMessage.roomId === roomId) {
      const body = textRef.current.trim()
      if (!body) return
      const targetId = editingMessage.eventId
      sendingRef.current = true
      clearInput()
      try {
        await editMessage(roomId, targetId, body)
      } finally {
        sendingRef.current = false
      }
      inputRef.current?.focus()
      return
    }

    if (pendingFiles.length > 0) {
      sendingRef.current = true
      const files = pendingFiles
      // The typed text becomes the caption on the FIRST attachment only
      // (WhatsApp / Beeper behaviour); the rest send bare. Matrix sends each
      // as its own m.image/m.file event, dispatched in order.
      const caption = textRef.current.trim() || undefined
      clearAttachments()
      clearInput()
      try {
        for (let i = 0; i < files.length; i++) {
          const { file } = files[i]!
          const cap = i === 0 ? caption : undefined
          if (file.type.startsWith('image/')) {
            await sendImage(roomId, file, cap)
          } else {
            await sendFile(roomId, file, cap)
          }
        }
      } finally {
        sendingRef.current = false
      }
      inputRef.current?.focus()
      return
    }

    const body = textRef.current.trim()
    if (!body) return

    const fmt = buildMentionsFormatted(body, pendingMentionsRef.current)
    const mentionUserIds = fmt?.activeMentions.map((m) => m.userId)

    sendingRef.current = true
    clearInput()
    try {
      await sendMessage(roomId, body, fmt?.formattedBody, mentionUserIds)
    } finally {
      sendingRef.current = false
    }
    inputRef.current?.focus()
  }, [roomId, sendMessage, sendImage, sendFile, pendingFiles, clearAttachments, clearInput, editingMessage, editMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // @-mention autocomplete keyboard handling (takes priority over emoji
    // because the mention picker is what's actively open at this moment).
    if (mentionQuery && mentionResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionSelectedIdx(i => Math.min(i + 1, mentionResults.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionSelectedIdx(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = mentionResults[mentionSelectedIdx]
        if (selected) selectMention(selected)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        setMentionResults([])
        return
      }
    }

    // Emoji autocomplete keyboard handling
    if (emojiQuery && emojiResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setEmojiSelectedIdx(i => Math.min(i + 1, emojiResults.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setEmojiSelectedIdx(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = emojiResults[emojiSelectedIdx]
        if (selected) selectEmoji(selected)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setEmojiQuery(null)
        setEmojiResults([])
        return
      }
    }

    if (e.key === 'Escape' && editingMessage) {
      e.preventDefault()
      setEditingMessage(null)
      clearInput()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, emojiQuery, emojiResults, emojiSelectedIdx, selectEmoji, mentionQuery, mentionResults, mentionSelectedIdx, selectMention, editingMessage, setEditingMessage, clearInput])

  const resizeScheduledRef = useRef(false)
  const autoResize = useCallback(() => {
    if (resizeScheduledRef.current) return
    resizeScheduledRef.current = true
    requestAnimationFrame(() => {
      resizeScheduledRef.current = false
      const el = inputRef.current
      if (!el) return
      el.style.height = '24px'
      el.style.height = Math.min(120, el.scrollHeight) + 'px'
    })
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    textRef.current = value
    const nowHasContent = !!value.trim()
    if (nowHasContent !== hasContent) setHasContent(nowHasContent)
    autoResize()
    const cursorPos = e.target.selectionStart
    detectEmojiQuery(value, cursorPos)
    detectMentionQuery(value, cursorPos)
    useGlassesStore.getState().setComposerText('chat', value)
  }, [detectEmojiQuery, detectMentionQuery, autoResize, hasContent])

  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Arrow keys move cursor without triggering onChange
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      const cursorPos = e.currentTarget.selectionStart
      detectEmojiQuery(textRef.current, cursorPos)
      detectMentionQuery(textRef.current, cursorPos)
    }
  }, [detectEmojiQuery, detectMentionQuery])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    // Attach EVERY pasted image (clipboards can hold several), not just the
    // first — matches the Agents-tab paste behaviour. preventDefault only
    // when we actually consumed an image, so pasting plain text still works.
    let consumed = false
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) { attachFile(file); consumed = true }
      }
    }
    if (consumed) e.preventDefault()
  }, [attachFile])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files) for (const file of Array.from(files)) attachFile(file)
    e.target.value = ''
  }, [attachFile])

  return (
    <div className="border-t border-border">
      {/* Emoji autocomplete dropdown */}
      {emojiQuery && emojiResults.length > 0 && (
        <div className="px-3 pt-2">
          <div className="bg-surface-1 border border-border rounded-sm shadow-lg py-1 max-h-48 overflow-y-auto">
            {emojiResults.map((result, i) => (
              <button
                key={result.shortcode}
                onMouseDown={(e) => { e.preventDefault(); selectEmoji(result) }}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm ${
                  i === emojiSelectedIdx ? 'bg-surface-2' : 'hover:bg-surface-1'
                }`}
              >
                <span className="text-base">{result.emoji}</span>
                <span className="text-text-secondary">:{result.shortcode}:</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* @-mention dropdown. Same visual treatment as the emoji picker so
          users have one mental model for autocomplete. */}
      {mentionQuery && mentionResults.length > 0 && (
        <div className="px-3 pt-2">
          <div className="bg-surface-1 border border-border rounded-sm shadow-lg py-1 max-h-48 overflow-y-auto">
            {mentionResults.map((m, i) => {
              const localpart = (m.userId.split(':')[0] ?? '').slice(1)
              const display = m.displayName || localpart
              return (
                <button
                  key={m.userId}
                  onMouseDown={(e) => { e.preventDefault(); selectMention(m) }}
                  className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm ${
                    i === mentionSelectedIdx ? 'bg-surface-2' : 'hover:bg-surface-1'
                  }`}
                >
                  <span className="text-text-primary">@{display}</span>
                  {display !== localpart && (
                    <span className="text-xs text-text-tertiary truncate">{m.userId}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="px-3 py-2">
        {/* Reply preview */}
        {replyingTo && !editingMessage && (
          <div className="flex items-center justify-between pt-1 pb-1.5 min-w-0">
            <div className="flex-1 min-w-0 border-l-2 border-text-secondary pl-2">
              <span className="text-xs font-medium text-text-secondary">{replyingTo.senderName}</span>
              <p className="text-xs text-text-tertiary truncate">{replyingTo.body}</p>
            </div>
            <button onClick={() => setReplyingTo(null)} className="text-text-tertiary hover:text-text-primary p-1">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Edit preview — replaces the reply pill while in edit mode. Cancel
            with the X or by hitting Escape in the textarea. */}
        {editingMessage && editingMessage.roomId === roomId && (
          <div className="flex items-center justify-between pt-1 pb-1.5 min-w-0">
            <div className="flex-1 min-w-0 border-l-2 border-blue-500/60 pl-2">
              <span className="text-xs font-medium text-blue-400">Editing</span>
              <p className="text-xs text-text-tertiary truncate">{editingMessage.body}</p>
            </div>
            <button
              onClick={() => { setEditingMessage(null); clearInput() }}
              className="text-text-tertiary hover:text-text-primary p-1"
              title="Cancel edit (Esc)"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Attachment previews — a horizontal strip; image thumbnails and
            filename chips for non-images, each individually removable. */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap items-start gap-2 mb-2">
            {pendingFiles.map((p) => (
              p.preview ? (
                <div key={p.id} className="relative inline-block">
                  <img
                    src={p.preview}
                    alt="Preview"
                    className="max-h-24 max-w-32 rounded-sm border border-border object-cover"
                  />
                  <button
                    onClick={() => removeAttachment(p.id)}
                    className="absolute -top-1.5 -right-1.5 rounded-full bg-surface-2 border border-border p-0.5 text-text-tertiary hover:text-text-primary"
                  >
                    <X size={10} />
                  </button>
                </div>
              ) : (
                <div key={p.id} className="inline-flex items-center gap-2 rounded-sm border border-border bg-surface-1 px-2 py-1 text-xs text-text-secondary">
                  <Paperclip size={12} className="text-text-tertiary" />
                  <span className="truncate max-w-[160px]">{p.file.name}</span>
                  <span className="text-text-tertiary tabular-nums">
                    {p.file.size < 1024 ? `${p.file.size}B`
                      : p.file.size < 1024 * 1024 ? `${Math.round(p.file.size / 1024)}KB`
                      : `${(p.file.size / 1024 / 1024).toFixed(1)}MB`}
                  </span>
                  <button onClick={() => removeAttachment(p.id)} className="text-text-tertiary hover:text-text-primary" title="Remove">
                    <X size={12} />
                  </button>
                </div>
              )
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 text-text-tertiary hover:text-text-primary transition-colors duration-fast p-1"
            title="Attach file"
          >
            <Paperclip size={14} />
          </button>
          <textarea
            ref={inputRef}
            data-chat-input
            defaultValue=""
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onPaste={handlePaste}
            placeholder="Message..."
            rows={1}
            className="flex-1 w-0 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none min-h-[24px] max-h-[120px] overflow-y-auto"
          />
          <button
            onClick={handleSend}
            disabled={!hasContent && pendingFiles.length === 0}
            className="flex-shrink-0 text-text-tertiary hover:text-text-primary disabled:opacity-30 transition-colors duration-fast p-1"
            title="Send (Enter)"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  )
})
