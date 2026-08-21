// ============================================================================
// STT relay config + event translation for the OpenAI Realtime GA API.
//
// History (why this module exists — all three failure modes actually shipped):
//   1. `wss://api.openai.com/v1/realtime/transcription` → HTTP 403 at the
//      WebSocket handshake. Wrong path.
//   2. `wss://api.openai.com/v1/realtime?intent=transcription` with the
//      `OpenAI-Beta: realtime=v1` header → connects, then the first message is
//      rejected with `beta_api_shape_disabled` ("The Realtime Beta API is no
//      longer supported. Please use /v1/realtime for the GA API.").
//   3. GA API (May 2026 voice-intelligence drop): bare `/v1/realtime`, NO beta
//      header, nested `session.update` shape. This is the working config and
//      the tests in __tests__/stt.test.ts pin it.
// ============================================================================

// GA realtime transcription endpoint. Empirically (June 2026, live API):
//   - bare `/v1/realtime`       → requires a realtime *session* model in
//                                  `?model=`; rejects whisper as the session model.
//   - `?intent=transcription`   → transcription session; the whisper model goes
//     + NO beta header            in audio.input.transcription.model. WORKS.
//   - `?intent` + beta header   → `beta_api_shape_disabled`.
// `?intent=transcription` is NOT the beta shape — the earlier beta rejection was
// caused solely by the `OpenAI-Beta: realtime=v1` header, not the intent param.
export const STT_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'

/** Streaming STT model: emits transcript deltas word-by-word as audio arrives
 *  (vs gpt-4o-mini-transcribe's bursty sentence-boundary commits). */
export const STT_MODEL = 'gpt-realtime-whisper'

/**
 * How long the client must go without sending audio before the relay commits
 * the input buffer.
 *
 * `gpt-realtime-whisper` rejects `turn_detection`, so nothing ever closes a turn
 * on its own — it streams deltas lazily and the tail of an utterance can sit
 * unemitted for 5–8 s (measured). Clients close the socket the instant the user
 * releases the mic, so those deltas arrived after disconnect and were dropped:
 * short utterances lost their ending, and a brief one could yield NOTHING.
 *
 * Committing on IDLE, not on a periodic timer, is the distinction that matters —
 * periodic commits chop mid-sentence and wrecked accuracy (see
 * memory/feedback_stt_no_periodic_commits.md). Every append resets this timer,
 * so a commit only lands in a genuine gap. Kept above a natural inter-word pause
 * and below the pause a user reads as "it's broken".
 */
export const STT_FLUSH_IDLE_MS = 600

/**
 * Cap on how long the relay holds a client socket open after `{type:'done'}`
 * (mic released) waiting for the final transcript. The relay closes the socket
 * as soon as the final arrives, so this only bounds the pathological case where
 * the model never completes — without it a stuck turn would strand the mic UI.
 */
export const STT_DONE_TIMEOUT_MS = 4_000

/**
 * Byte cap on audio frames buffered while the OpenAI WS is still CONNECTING.
 *
 * The TLS+WS handshake to api.openai.com takes ~0.5–1.5 s, and the relay used
 * to silently DROP any audio arriving before it completed — so the opening
 * words of every dictation were lost for anyone who starts talking the moment
 * they press the mic (the "it only starts recording a few seconds in" bug).
 * Frames are queued and flushed on open instead. ~2 MB of base64 PCM16@24kHz
 * ≈ 30 s of speech — far beyond any real handshake; overflow drops the OLDEST
 * frames (the tail is closer to the commit).
 */
export const STT_PREBUFFER_MAX_BYTES = 2 * 1024 * 1024

/** Append a frame to a pre-open buffer, evicting OLDEST frames past the byte
 *  cap. Returns the new byte total (callers track it to avoid re-summing). */
export function pushCapped(buf: string[], frame: string, bytes: number, maxBytes = STT_PREBUFFER_MAX_BYTES): number {
  buf.push(frame)
  bytes += frame.length
  while (bytes > maxBytes && buf.length > 1) bytes -= buf.shift()!.length
  return bytes
}

/** Batch (`/v1/audio/transcriptions`) model, for the whole-file paths: the
 *  `/stt` upload endpoint and Al's WhatsApp voice notes. Deliberately a
 *  DIFFERENT model from the realtime one above — the realtime endpoint rejects
 *  this id and vice versa, so they can't be collapsed into one constant. */
export const STT_BATCH_MODEL = 'gpt-transcribe'

/** Headers for the GA handshake. Notably NO `OpenAI-Beta: realtime=v1` —
 *  sending it flips the connection into the disabled beta shape. */
export function buildSttHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

/** GA session config: transcription session, 24kHz mono PCM (matching the
 *  browser's AudioContext capture rate in AgentPromptInput).
 *
 *  NO turn_detection: gpt-realtime-whisper rejects it ("Turn detection is not
 *  supported for this transcription model") — it streams transcript deltas
 *  continuously as audio arrives rather than waiting for VAD turn boundaries. */
export function buildTranscriptionSessionUpdate(): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: { model: STT_MODEL, language: 'en' },
          noise_reduction: { type: 'near_field' },
        },
      },
    },
  }
}

export type SttClientMessage =
  | { type: 'interim'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }

/**
 * Translate an OpenAI realtime server event into the message our browser STT
 * client understands. Returns null for events the client doesn't care about
 * (session acks, VAD start/stop, item lifecycle, …).
 */
export function translateOpenAiEvent(msg: Record<string, unknown>): SttClientMessage | null {
  const type = msg.type as string | undefined
  switch (type) {
    case 'conversation.item.input_audio_transcription.delta':
      return { type: 'interim', text: (msg.delta as string) || '' }
    case 'conversation.item.input_audio_transcription.completed':
      return { type: 'final', text: (msg.transcript as string) || '' }
    case 'conversation.item.input_audio_transcription.failed': {
      const err = msg.error as { message?: string } | undefined
      return { type: 'error', message: err?.message || 'Transcription failed' }
    }
    case 'error': {
      const err = msg.error as { message?: string } | undefined
      return { type: 'error', message: err?.message || 'Transcription error' }
    }
    default:
      return null
  }
}
