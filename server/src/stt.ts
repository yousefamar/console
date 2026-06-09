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
