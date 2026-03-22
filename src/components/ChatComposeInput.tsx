import { useState, useRef, useCallback, useEffect, memo } from 'react'
import { useChatStore } from '@/store/chat'
import { Send, ImagePlus, X } from 'lucide-react'
import { searchEmoji } from '@/utils/emoji-shortcodes'

interface ChatComposeInputProps {
  roomId: string
}

export const ChatComposeInput = memo(function ChatComposeInput({ roomId }: ChatComposeInputProps) {
  const [text, setText] = useState('')
  const [pendingImage, setPendingImage] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [emojiQuery, setEmojiQuery] = useState<{ query: string; startIdx: number } | null>(null)
  const [emojiResults, setEmojiResults] = useState<{ shortcode: string; emoji: string }[]>([])
  const [emojiSelectedIdx, setEmojiSelectedIdx] = useState(0)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const sendImage = useChatStore((s) => s.sendImage)
  const replyingTo = useChatStore((s) => s.replyingTo)
  const setReplyingTo = useChatStore((s) => s.setReplyingTo)
  const sendingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus input when replyingTo changes
  useEffect(() => {
    if (replyingTo) {
      inputRef.current?.focus()
    }
  }, [replyingTo])

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
      setEmojiResults([])
    }
  }, [])

  const attachImage = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return
    setPendingImage(file)
    setImagePreview(URL.createObjectURL(file))
  }, [])

  const clearImage = useCallback(() => {
    if (imagePreview) URL.revokeObjectURL(imagePreview)
    setPendingImage(null)
    setImagePreview(null)
  }, [imagePreview])

  const selectEmoji = useCallback((result: { shortcode: string; emoji: string }) => {
    if (!emojiQuery) return
    const before = text.slice(0, emojiQuery.startIdx)
    const after = text.slice(emojiQuery.startIdx + emojiQuery.query.length + 1) // +1 for the colon
    const newText = before + result.emoji + after
    setText(newText)
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
  }, [emojiQuery, text])

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return

    if (pendingImage) {
      sendingRef.current = true
      const file = pendingImage
      const caption = text.trim() || undefined
      clearImage()
      setText('')
      try {
        await sendImage(roomId, file, caption)
      } finally {
        sendingRef.current = false
      }
      inputRef.current?.focus()
      return
    }

    const body = text.trim()
    if (!body) return

    sendingRef.current = true
    setText('')
    try {
      await sendMessage(roomId, body)
    } finally {
      sendingRef.current = false
    }
    inputRef.current?.focus()
  }, [text, roomId, sendMessage, sendImage, pendingImage, clearImage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, emojiQuery, emojiResults, emojiSelectedIdx, selectEmoji])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setText(value)
    const cursorPos = e.target.selectionStart
    detectEmojiQuery(value, cursorPos)
  }, [detectEmojiQuery])

  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Arrow keys move cursor without triggering onChange
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      const cursorPos = e.currentTarget.selectionStart
      detectEmojiQuery(text, cursorPos)
    }
  }, [text, detectEmojiQuery])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) attachImage(file)
        return
      }
    }
  }, [attachImage])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) attachImage(file)
    e.target.value = ''
  }, [attachImage])

  return (
    <div className="relative border-t border-border">
      {/* Emoji autocomplete dropdown */}
      {emojiQuery && emojiResults.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 mx-3">
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

      <div className="px-3 py-2">
        {/* Reply preview */}
        {replyingTo && (
          <div className="flex items-center justify-between pt-1 pb-1.5">
            <div className="flex-1 min-w-0 border-l-2 border-text-secondary pl-2">
              <span className="text-xs font-medium text-text-secondary">{replyingTo.senderName}</span>
              <p className="text-xs text-text-tertiary truncate">{replyingTo.body}</p>
            </div>
            <button onClick={() => setReplyingTo(null)} className="text-text-tertiary hover:text-text-primary p-1">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Image preview */}
        {imagePreview && (
          <div className="relative inline-block mb-2">
            <img
              src={imagePreview}
              alt="Preview"
              className="max-h-32 max-w-48 rounded-sm border border-border"
            />
            <button
              onClick={clearImage}
              className="absolute -top-1.5 -right-1.5 rounded-full bg-surface-2 border border-border p-0.5 text-text-tertiary hover:text-text-primary"
            >
              <X size={10} />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 text-text-tertiary hover:text-text-primary transition-colors duration-fast p-1"
            title="Attach image"
          >
            <ImagePlus size={14} />
          </button>
          <textarea
            ref={inputRef}
            data-chat-input
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onPaste={handlePaste}
            placeholder="Message..."
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none min-h-[24px] max-h-[120px]"
            style={{ height: Math.min(120, Math.max(24, text.split('\n').length * 20)) }}
          />
          <button
            onClick={handleSend}
            disabled={!text.trim() && !pendingImage}
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
