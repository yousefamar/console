// Shared dictation hook — speech-to-text via browser SpeechRecognition with
// fallback to the hub's /stt WebSocket (OpenAI realtime transcription).
// Extracted from AgentPromptInput so the Notes writing mode can dictate too.
//
// Text delivery contract: `onText(chunk)` fires for each committed text chunk.
// - Hub-STT streaming deltas are append-only word chunks → each fires onText.
// - A `final` from a non-streaming VAD model fires onText ONLY when no deltas
//   covered the utterance (prevents duplication) — same dedup the agents
//   input used.
// - Browser-SR final result chunks each fire onText. Interim (uncommitted)
//   text is exposed via the `interim` state for optional preview display.

import { useCallback, useRef, useState } from 'react'
import { isNative } from '@/platform'

interface DictationOptions {
  /** Called with each committed text chunk, in order. */
  onText?: (text: string) => void
  /** Alias used by some consumers; fired identically to onText. */
  onFinalSegment?: (text: string) => void
  lang?: string
}

export interface Dictation {
  recording: boolean
  /** In-flight (uncommitted) browser-SR text — empty for the hub path. */
  interim: string
  start: () => void
  stop: () => void
  toggle: () => void
}

export function useDictation(opts: DictationOptions = {}): Dictation {
  const [recording, setRecording] = useState(false)
  const [interim, setInterim] = useState('')

  const optsRef = useRef(opts)
  optsRef.current = opts

  const recognitionRef = useRef<any>(null)
  const sttWsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sawDeltaRef = useRef(false)

  const emit = useCallback((text: string) => {
    if (!text) return
    optsRef.current.onText?.(text)
    optsRef.current.onFinalSegment?.(text)
  }, [])

  const stop = useCallback(() => {
    // Tear down robustly: each step is guarded so one failure can't skip the
    // others — critically track.stop(), which is what frees the OS mic. And the
    // capture nodes are disconnected explicitly: on Chromium/WebView a connected
    // ScriptProcessor/MediaStreamSource keeps the mic device "live" (Android's
    // green mic indicator stays on after you finish) until the graph is torn
    // down — closing the AudioContext alone doesn't reliably release it.
    try { recognitionRef.current?.stop() } catch { /* */ }
    recognitionRef.current = null
    try { sttWsRef.current?.close() } catch { /* */ }
    sttWsRef.current = null
    if (processorRef.current) {
      try { processorRef.current.onaudioprocess = null; processorRef.current.disconnect() } catch { /* */ }
      processorRef.current = null
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect() } catch { /* */ }
      sourceRef.current = null
    }
    if (mediaStreamRef.current) {
      try { mediaStreamRef.current.getTracks().forEach((t) => t.stop()) } catch { /* */ }
      mediaStreamRef.current = null
    }
    if (audioContextRef.current) {
      try { void audioContextRef.current.close() } catch { /* */ }
      audioContextRef.current = null
    }
    sawDeltaRef.current = false
    setRecording(false)
    setInterim('')
  }, [])

  const startHubSTT = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const { getHubWsUrl } = await import('@/hub')
      const ws = new WebSocket(getHubWsUrl().replace(/\/$/, '') + '/stt')
      sttWsRef.current = ws
      sawDeltaRef.current = false

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'interim') {
            // Streaming deltas are append-only word chunks — commit each.
            sawDeltaRef.current = true
            emit(msg.text || '')
          } else if (msg.type === 'final') {
            // Only commit a `final` when no deltas covered it.
            if (!sawDeltaRef.current) emit((msg.text || '').trim())
            sawDeltaRef.current = false
          } else if (msg.type === 'error') {
            console.warn('[dictation]', msg.message)
          }
        } catch { /* ignore */ }
      }

      ws.onclose = () => { stop() }
      ws.onerror = () => { ws.close() }

      ws.onopen = () => {
        const audioCtx = new AudioContext({ sampleRate: 24000 })
        audioContextRef.current = audioCtx
        // Mobile WebViews/Safari create the context suspended even from a user
        // gesture; without resume() onaudioprocess never fires → no audio sent.
        if (audioCtx.state === 'suspended') void audioCtx.resume()
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        sourceRef.current = source
        processorRef.current = processor
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
    } catch (err) {
      // Surface the cause (e.g. NotAllowedError = mic permission denied)
      console.warn('[dictation] mic capture failed:', (err as Error).name, (err as Error).message)
      stop()
    }
  }, [emit, stop])

  const startBrowserSTT = useCallback((): boolean => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return false
    const recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = optsRef.current.lang ?? 'en-GB'
    let failed = false
    recognition.onresult = (event: any) => {
      let interimAcc = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          emit(t)
          setInterim('')
        } else {
          interimAcc += t
        }
      }
      if (interimAcc) setInterim(interimAcc)
    }
    recognition.onend = () => {
      if (!failed) {
        setRecording(false)
        setInterim('')
        recognitionRef.current = null
      }
    }
    recognition.onerror = (e: any) => {
      if (e.error === 'network' || e.error === 'service-not-allowed' || e.error === 'not-allowed') {
        failed = true
        recognition.stop()
        recognitionRef.current = null
        void startHubSTT()
      } else {
        setRecording(false)
        setInterim('')
        recognitionRef.current = null
      }
    }
    recognitionRef.current = recognition
    recognition.start()
    return true
  }, [emit, startHubSTT])

  const start = useCallback(() => {
    if (recording) return
    setRecording(true)
    // APK WebView's SpeechRecognition shim is unreliable — go straight to hub STT.
    if (isNative() || !startBrowserSTT()) {
      void startHubSTT()
    }
  }, [recording, startBrowserSTT, startHubSTT])

  const toggle = useCallback(() => {
    if (recording) stop()
    else start()
  }, [recording, start, stop])

  return { recording, interim, start, stop, toggle }
}
