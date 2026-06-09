import { memo, useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useAgentStore } from '@/store/agent'
import { useGlassesStore } from '@/glasses/store'
import { getHubUrl } from '@/hub'
import { Send, Square, Plus, FolderOpen, RotateCcw, X, Mic, Paperclip } from 'lucide-react'

// ============================================================================
// AgentPromptInput — text input for sending prompts to the agent.
// Supports creating new sessions and sending follow-up messages.
// When no session is active, shows a directory picker with autocomplete.
// ============================================================================

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export const AgentPromptInput = memo(function AgentPromptInput() {
  // Text lives in a ref + the textarea's uncontrolled value, NOT React state.
  // Typing mutates the DOM directly, triggering zero React renders per keystroke.
  const textRef = useRef('')
  const [hasContent, setHasContent] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [dirInput, setDirInput] = useState('')
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [dirOpen, setDirOpen] = useState(false)
  const [dirIndex, setDirIndex] = useState(0)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null)
  const [images, setImages] = useState<Array<{ media_type: string; data: string; preview: string }>>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const slashListRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendingRef = useRef(false)
  const [listening, setListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const recognitionRef = useRef<any>(null)
  const sttWsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  // True once a streaming delta has been inserted for the current OpenAI STT
  // session — lets us ignore a trailing `final` (its text is already in the
  // textarea from the deltas) while still honouring a `final` from any model
  // that sends only a final and no deltas.
  const sawSttDeltaRef = useRef(false)

  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const isRunning = useAgentStore((s) => s.sessions.find((sess) => sess.id === s.activeSessionId)?.status === 'running')
  const connected = useAgentStore((s) => s.connected)
  const createSession = useAgentStore((s) => s.createSession)
  const sendMessage = useAgentStore((s) => s.sendMessage)
  const interrupt = useAgentStore((s) => s.interrupt)
  const projectDirs = useAgentStore((s) => s.projectDirs)
  const slashCommands = useAgentStore((s) => s.sessionSlashCommands)
  const pastSessions = useAgentStore((s) => s.pastSessions)
  const resumeSession = useAgentStore((s) => s.resumeSession)

  // Filesystem dir suggestions — fetched from hub when the user types a path-like
  // string (starts with `/` or `~`). Lets them tab-complete into directories that
  // aren't existing Claude project dirs.
  const [fsDirs, setFsDirs] = useState<string[]>([])
  useEffect(() => {
    const q = dirInput.trim()
    if (!q.startsWith('/') && !q.startsWith('~')) {
      setFsDirs([])
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${getHubUrl()}/agents/list-dirs?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        if (!res.ok) return
        const { dirs } = await res.json() as { dirs: string[] }
        setFsDirs(dirs)
      } catch { /* aborted or offline */ }
    }, 80)
    return () => { ctrl.abort(); clearTimeout(t) }
  }, [dirInput])

  // Filter project dirs by substring; merge with filesystem suggestions, dedup.
  const filteredDirs = useMemo(() => {
    const q = dirInput.trim()
    const projects = q
      ? projectDirs.filter((d) => {
          const lq = q.toLowerCase()
          return d.toLowerCase().includes(lq) || basename(d).toLowerCase().includes(lq)
        })
      : projectDirs
    if (fsDirs.length === 0) return projects
    const seen = new Set(projects)
    const merged = [...projects]
    for (const d of fsDirs) if (!seen.has(d)) merged.push(d)
    return merged
  }, [dirInput, projectDirs, fsDirs])

  // Slash command filtering — driven by slashQuery state, updated only in onChange
  const filteredSlash = useMemo(() => slashOpen
    ? slashCommands.filter((cmd) => cmd.toLowerCase().startsWith(slashQuery))
    : [], [slashOpen, slashCommands, slashQuery])

  // Clamp slash index
  useEffect(() => {
    setSlashIndex((i) => Math.min(i, Math.max(0, filteredSlash.length - 1)))
  }, [filteredSlash.length])

  // Scroll selected slash item into view
  useEffect(() => {
    if (!slashListRef.current) return
    const el = slashListRef.current.children[slashIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex])

  // Clamp index when filtered list changes
  useEffect(() => {
    setDirIndex((i) => Math.min(i, Math.max(0, filteredDirs.length - 1)))
  }, [filteredDirs.length])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[dirIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [dirIndex])

  const resizeScheduledRef = useRef(false)
  const resizeTextarea = useCallback(() => {
    if (resizeScheduledRef.current) return
    resizeScheduledRef.current = true
    requestAnimationFrame(() => {
      resizeScheduledRef.current = false
      const el = inputRef.current
      if (!el) return
      el.style.height = '24px'
      const maxH = Math.floor(window.innerHeight * 0.5)
      el.style.height = Math.min(maxH, el.scrollHeight) + 'px'
    })
  }, [])

  // Sync textarea DOM value when interim STT text changes, then resize.
  // Committed text changes are applied imperatively at their source — no React reactivity.
  // NOTE: only the browser-SpeechRecognition fallback uses `interimText` (its
  // results revise in place). The OpenAI/gpt-realtime-whisper path inserts each
  // delta straight into the textarea at the caret (see insertAtCaret), so its
  // transcript is live-editable and this effect is a no-op for it.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const base = textRef.current
    el.value = interimText ? base + (base ? ' ' : '') + interimText : base
    resizeTextarea()
  }, [interimText, resizeTextarea])

  /** Insert text at the textarea's current caret (replacing any selection),
   *  keeping textRef in sync and advancing the caret past the insertion. Lets
   *  streamed speech land wherever the user has placed the cursor and coexist
   *  with manual edits made mid-recording. */
  const insertAtCaret = useCallback((insert: string) => {
    if (!insert) return
    const el = inputRef.current
    if (!el) { textRef.current += insert; return }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const before = el.value.slice(0, start)
    const after = el.value.slice(end)
    // Add a separating space only when gluing two word characters together
    // (whisper deltas usually include their own leading space, so this rarely fires).
    const needsSpace = before.length > 0 && /\w$/.test(before) && /^\w/.test(insert)
    const piece = needsSpace ? ' ' + insert : insert
    const next = before + piece + after
    el.value = next
    textRef.current = next
    const caret = start + piece.length
    el.setSelectionRange(caret, caret)
    setHasContent(!!next.trim())
    resizeTextarea()
  }, [resizeTextarea])

  // Fetch past sessions when a directory is selected
  useEffect(() => {
    if (selectedDir && !activeSessionId) {
      useAgentStore.getState().listPastSessions(selectedDir)
    } else {
      useAgentStore.setState({ pastSessions: [] })
    }
    setSelectedResumeId(null)
  }, [selectedDir, activeSessionId])

  const resolvedCwd = selectedDir || undefined

  const imagePayload = images.length > 0
    ? images.map(({ media_type, data }) => ({ media_type, data }))
    : undefined

  const clearInput = useCallback(() => {
    textRef.current = ''
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.style.height = '24px'
    }
    setHasContent(false)
    setSlashOpen(false)
    setSlashQuery('')
    useGlassesStore.getState().setComposerText('agents', '')
  }, [])

  const handleSend = useCallback(() => {
    if (sendingRef.current) return
    if (listening) stopListening()
    const body = textRef.current.trim()
    if (!body && !imagePayload) return

    sendingRef.current = true
    clearInput()
    setImages([])

    if (activeSessionId) {
      sendMessage(body || 'What do you see in this image?', imagePayload)
    } else if (selectedResumeId) {
      resumeSession(selectedResumeId, body || 'What do you see in this image?', resolvedCwd)
      setSelectedResumeId(null)
      setSelectedDir(null)
      setDirInput('')
    } else {
      createSession(body || 'What do you see in this image?', resolvedCwd, imagePayload)
      setSelectedDir(null)
      setDirInput('')
    }

    sendingRef.current = false
    inputRef.current?.focus()
  }, [imagePayload, activeSessionId, sendMessage, createSession, resumeSession, selectedResumeId, resolvedCwd, clearInput])

  const handleNewSession = useCallback(() => {
    const body = textRef.current.trim()
    if (!body && !imagePayload) return
    clearInput()
    setImages([])
    createSession(body || 'What do you see in this image?', resolvedCwd, imagePayload)
    setSelectedDir(null)
    setDirInput('')
    inputRef.current?.focus()
  }, [imagePayload, createSession, resolvedCwd, clearInput])

  const attachImage = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // data:image/png;base64,XXXX → extract media_type and data
      const match = result.match(/^data:(image\/[^;]+);base64,(.+)$/)
      if (match) {
        setImages((prev) => [...prev, {
          media_type: match[1]!,
          data: match[2]!,
          preview: result,
        }])
      }
    }
    reader.readAsDataURL(file)
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files) {
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) attachImage(file)
      }
    }
    e.target.value = ''
  }, [attachImage])

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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Slash command autocomplete navigation
    if (slashOpen && filteredSlash.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => Math.min(i + 1, filteredSlash.length - 1))
        return
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => Math.max(i - 1, 0))
        return
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (filteredSlash[slashIndex]) {
          e.preventDefault()
          const full = '/' + filteredSlash[slashIndex]
          textRef.current = full
          if (inputRef.current) inputRef.current.value = full
          setHasContent(true)
          setSlashOpen(false)
          setSlashQuery('')
          resizeTextarea()
          return
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSlashOpen(false)
        return
      }
    }

    // Shift+Cmd+Enter for new session
    if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleNewSession()
      return
    }
    // Enter sends, Ctrl+Enter for new line
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend, handleNewSession, slashOpen, filteredSlash, slashIndex, resizeTextarea])

  const handleDirKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!dirOpen || filteredDirs.length === 0) {
      // Enter in dir field when closed = focus prompt
      if (e.key === 'Enter') {
        e.preventDefault()
        inputRef.current?.focus()
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setDirIndex((i) => Math.min(i + 1, filteredDirs.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setDirIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (filteredDirs[dirIndex]) {
        e.preventDefault()
        selectDir(filteredDirs[dirIndex], { focusPrompt: true })
      }
    } else if (e.key === 'Tab') {
      if (filteredDirs[dirIndex]) {
        e.preventDefault()
        selectDir(filteredDirs[dirIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDirOpen(false)
    }
  }, [dirOpen, filteredDirs, dirIndex])

  const selectDir = useCallback((dir: string, opts?: { focusPrompt?: boolean }) => {
    setSelectedDir(dir)
    setDirInput(dir)
    setDirOpen(false)
    if (opts?.focusPrompt) {
      // Move focus to the prompt textarea (Enter / mouse click path)
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      // Tab-complete: stay in the dir input so the user can keep refining the path
      setTimeout(() => {
        const el = dirRef.current
        if (!el) return
        const len = el.value.length
        el.setSelectionRange(len, len)
      }, 0)
    }
  }, [])

  const handleDirChange = useCallback((value: string) => {
    setDirInput(value)
    setSelectedDir(value.trim() || null)
    setDirIndex(0)
    setDirOpen(true)
  }, [])

  const handleDirFocus = useCallback(() => {
    setDirOpen(true)
    setDirIndex(0)
  }, [])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    if (sttWsRef.current) { sttWsRef.current.close(); sttWsRef.current = null }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null }
    if (mediaStreamRef.current) { mediaStreamRef.current.getTracks().forEach((t) => t.stop()); mediaStreamRef.current = null }
    // No flush needed: OpenAI-path deltas are inserted into the textarea live,
    // so the transcript is already committed. interimText only holds in-flight
    // browser-SR text, which is intentionally discarded on stop.
    sawSttDeltaRef.current = false
    setListening(false)
    setInterimText('')
    inputRef.current?.focus()
  }, [])

  const startBrowserSTT = useCallback((): boolean => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return false
    const recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-GB'
    let finalTranscript = textRef.current
    let failed = false
    recognition.onresult = (event: any) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += (finalTranscript ? ' ' : '') + t
          textRef.current = finalTranscript
          if (inputRef.current) inputRef.current.value = finalTranscript
          setHasContent(!!finalTranscript.trim())
          setInterimText('')
        } else {
          interim += t
        }
      }
      if (interim) setInterimText(interim)
    }
    recognition.onend = () => {
      if (!failed) { setListening(false); setInterimText(''); recognitionRef.current = null; inputRef.current?.focus() }
    }
    recognition.onerror = (e: any) => {
      if (e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'not-allowed') {
        failed = true
        recognition.stop()
        // Fall back to OpenAI
        startOpenAISTT()
      } else {
        setListening(false); setInterimText(''); recognitionRef.current = null
      }
    }
    recognitionRef.current = recognition
    recognition.start()
    return true
  }, [])

  const startOpenAISTT = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const { getHubWsUrl } = await import('@/hub')
      const ws = new WebSocket(getHubWsUrl().replace(/\/$/, '') + '/stt')
      sttWsRef.current = ws
      sawSttDeltaRef.current = false

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'interim') {
            // whisper-streaming deltas are append-only word chunks — insert each
            // straight at the caret as committed, editable text.
            sawSttDeltaRef.current = true
            insertAtCaret(msg.text || '')
          } else if (msg.type === 'final') {
            // Only insert a `final` when no deltas covered it (a final from a
            // VAD model that doesn't stream). Otherwise it would duplicate.
            if (!sawSttDeltaRef.current) insertAtCaret((msg.text || '').trim())
            sawSttDeltaRef.current = false
          } else if (msg.type === 'error') {
            console.warn('[stt]', msg.message)
          }
        } catch { /* ignore */ }
      }

      ws.onclose = () => { stopListening() }
      ws.onerror = () => { ws.close() }

      ws.onopen = () => {
        const audioCtx = new AudioContext({ sampleRate: 24000 })
        audioContextRef.current = audioCtx
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return
          const pcm = e.inputBuffer.getChannelData(0)
          const int16 = new Int16Array(pcm.length)
          for (let i = 0; i < pcm.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, pcm[i]! * 32768))
          }
          const bytes = new Uint8Array(int16.buffer)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
          ws.send(JSON.stringify({ type: 'audio', data: btoa(binary) }))
        }
        source.connect(processor)
        processor.connect(audioCtx.destination)
      }
    } catch {
      setListening(false)
      setInterimText('')
    }
  }, [stopListening])

  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening()
      return
    }
    setListening(true)
    // Focus the textarea so streamed words insert at a real caret position.
    inputRef.current?.focus()
    if (!startBrowserSTT()) {
      startOpenAISTT()
    }
  }, [listening, stopListening, startBrowserSTT, startOpenAISTT])

  if (!connected) return null

  const showDirPicker = !activeSessionId && activeSessionId !== 'al' && projectDirs.length > 0

  return (
    <div className="border-t border-border px-3 py-2">
      {/* Directory picker — only when no active session */}
      {showDirPicker && (
        <div className="mb-1.5 relative">
          {/* Autocomplete dropdown — floats above the input so the input doesn't shift when it opens */}
          {dirOpen && filteredDirs.length > 0 && (
            <div
              ref={listRef}
              className="absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto border border-border bg-surface-1 py-0.5 shadow-lg z-10"
            >
              {filteredDirs.map((dir, i) => (
                <button
                  key={dir}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectDir(dir, { focusPrompt: true })
                  }}
                  className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors duration-fast ${
                    i === dirIndex ? 'bg-surface-2' : 'hover:bg-surface-2'
                  }`}
                >
                  <span className="text-xs font-medium text-text-primary truncate">
                    {basename(dir)}
                  </span>
                  <span className="text-[10px] text-text-tertiary truncate">
                    {dir}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <FolderOpen size={12} className="text-text-tertiary flex-shrink-0" />
            <input
              ref={dirRef}
              value={dirInput}
              onChange={(e) => handleDirChange(e.target.value)}
              onKeyDown={handleDirKeyDown}
              onFocus={handleDirFocus}
              onBlur={() => setTimeout(() => setDirOpen(false), 150)}
              placeholder="~ (home directory)"
              className="flex-1 bg-transparent text-xs text-text-secondary placeholder:text-text-tertiary outline-none"
            />
            {selectedDir && (
              <button
                onClick={() => { setSelectedDir(null); setDirInput(''); dirRef.current?.focus() }}
                className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
              >
                clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Past sessions — resume picker */}
      {showDirPicker && selectedDir && pastSessions.length > 0 && (
        <div className="mb-1.5">
          <div className="flex items-center justify-between mb-0.5">
            <div className="flex items-center gap-1 text-[10px] text-text-tertiary">
              <RotateCcw size={9} />
              <span>Resume a past session</span>
            </div>
            {selectedResumeId && (
              <button
                onClick={() => setSelectedResumeId(null)}
                className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast flex items-center gap-0.5"
              >
                <X size={8} />
                <span>clear</span>
              </button>
            )}
          </div>
          <div className="max-h-[120px] overflow-y-auto">
            {pastSessions.slice(0, 5).map((ps) => (
              <button
                key={ps.sessionId}
                onClick={() => {
                  setSelectedResumeId(ps.sessionId === selectedResumeId ? null : ps.sessionId)
                  inputRef.current?.focus()
                }}
                className={`w-full text-left px-2 py-1 transition-colors duration-fast ${
                  ps.sessionId === selectedResumeId ? 'bg-surface-2' : 'hover:bg-surface-1'
                }`}
              >
                <div className="text-xs text-text-secondary truncate">{ps.prompt}</div>
                <div className="text-[10px] text-text-tertiary">{formatRelativeDate(ps.date)}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Slash command autocomplete */}
      <div>
        {slashOpen && filteredSlash.length > 0 && (
          <div
            ref={slashListRef}
            className="mb-1 w-full max-h-48 overflow-y-auto border border-border bg-surface-1 py-0.5 shadow-lg"
          >
            {filteredSlash.map((cmd, i) => (
              <button
                key={cmd}
                onMouseDown={(e) => {
                  e.preventDefault()
                  const full = '/' + cmd
                  textRef.current = full
                  if (inputRef.current) inputRef.current.value = full
                  setHasContent(true)
                  setSlashOpen(false)
                  setSlashQuery('')
                  resizeTextarea()
                  inputRef.current?.focus()
                }}
                className={`flex w-full items-center px-2.5 py-1 text-left transition-colors duration-fast ${
                  i === slashIndex ? 'bg-surface-2' : 'hover:bg-surface-2'
                }`}
              >
                <span className="text-xs font-mono text-text-primary">/{cmd}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Image preview strip */}
      {images.length > 0 && (
        <div className="flex gap-1.5 mb-1.5 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img
                src={img.preview}
                alt={`Pasted image ${i + 1}`}
                className="h-12 w-12 object-cover border border-border"
              />
              <button
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-surface-2 border border-border text-text-tertiary hover:text-text-primary flex items-center justify-center text-[8px] leading-none opacity-0 group-hover:opacity-100 transition-opacity duration-fast"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        <textarea
          ref={inputRef}
          defaultValue=""
          onInput={(e) => {
            if (listening) return
            const val = (e.target as HTMLTextAreaElement).value
            textRef.current = val
            const nowHasContent = !!val.trim()
            if (nowHasContent !== hasContent) setHasContent(nowHasContent)
            const nowSlash = val.startsWith('/')
            if (nowSlash && slashCommands.length > 0) {
              if (!slashOpen) { setSlashOpen(true); setSlashIndex(0) }
              const q = val.slice(1).toLowerCase()
              if (q !== slashQuery) setSlashQuery(q)
            } else if (slashOpen) {
              setSlashOpen(false)
            }
            resizeTextarea()
            useGlassesStore.getState().setComposerText('agents', val)
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          data-agent-input
          placeholder={activeSessionId === 'al' ? 'Message Al...' : activeSessionId ? 'Follow up...' : selectedResumeId ? 'Send a message to resume...' : 'Start a new agent session...'}
          rows={1}
          className="flex-1 w-0 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none min-h-[24px] max-h-[50vh] overflow-y-auto"
          disabled={!connected}
        />

        {isRunning ? (
          <button
            onClick={interrupt}
            className="flex-shrink-0 text-warning hover:text-warning/80 transition-colors duration-fast p-1"
            title="Interrupt (Esc)"
          >
            <Square size={14} />
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-shrink-0 text-text-tertiary hover:text-text-secondary transition-colors duration-fast p-1"
              title="Attach image"
            >
              <Paperclip size={14} />
            </button>
            {activeSessionId && (
              <button
                onClick={handleNewSession}
                disabled={!hasContent && images.length === 0}
                className="flex-shrink-0 text-text-tertiary hover:text-text-secondary disabled:opacity-30 transition-colors duration-fast p-1"
                title="New session (Shift+Cmd+Enter)"
              >
                <Plus size={14} />
              </button>
            )}
            <button
              onClick={toggleListening}
              className={`flex-shrink-0 transition-colors duration-fast p-1 cursor-pointer ${
                listening ? 'text-destructive animate-pulse' : 'text-text-tertiary hover:text-text-secondary'
              }`}
              title={listening ? 'Stop listening' : 'Voice input'}
            >
              <Mic size={14} />
            </button>
            <button
              onClick={handleSend}
              disabled={!hasContent && images.length === 0}
              className="flex-shrink-0 text-text-tertiary hover:text-text-primary disabled:opacity-30 transition-colors duration-fast p-1"
              title="Send (Enter)"
            >
              <Send size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
})

function formatRelativeDate(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w ago`
  return new Date(timestamp).toLocaleDateString()
}
