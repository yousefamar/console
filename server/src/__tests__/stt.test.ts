// STT GA-API config pins + event translation.
//
// These tests exist because the STT relay broke FOUR ways in production, each
// found by probing the live API (see stt.ts header):
//  1. 403 at handshake — wrong path `/v1/realtime/transcription`
//  2. `beta_api_shape_disabled` — `OpenAI-Beta: realtime=v1` header
//  3. `missing_model` / `invalid_model` — bare `/v1/realtime` treats `?model=`
//     as the realtime *session* model; whisper is a transcription model
//  4. "Turn detection is not supported for this transcription model" — sent
//     server_vad turn_detection (whisper streams continuously, no VAD)
// The verified config: `?intent=transcription`, NO beta header, GA nested
// session.update, NO turn_detection. These tests pin exactly that.

import { describe, it, expect } from 'vitest'
import {
  STT_REALTIME_URL,
  STT_MODEL,
  buildSttHeaders,
  buildTranscriptionSessionUpdate,
  translateOpenAiEvent,
} from '../stt.js'

describe('STT GA endpoint config', () => {
  it('uses the GA transcription-intent URL (not the 403 path, not bare /realtime)', () => {
    expect(STT_REALTIME_URL).toBe('wss://api.openai.com/v1/realtime?intent=transcription')
    // The `/v1/realtime/transcription` path 403s; must not regress to it.
    expect(STT_REALTIME_URL).not.toContain('/realtime/transcription')
    // Bare `/realtime` would demand a realtime session model in ?model=.
    expect(STT_REALTIME_URL).toContain('intent=transcription')
  })

  it('does NOT send the OpenAI-Beta header (beta shape is disabled server-side)', () => {
    const headers = buildSttHeaders('sk-test')
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('openai-beta')
    expect(headers.Authorization).toBe('Bearer sk-test')
  })
})

describe('GA transcription session payload', () => {
  const payload = buildTranscriptionSessionUpdate() as {
    type: string
    session: {
      type: string
      audio: { input: Record<string, unknown> }
    } & Record<string, unknown>
  }

  it('is a GA session.update (not the disabled beta transcription_session.update)', () => {
    expect(payload.type).toBe('session.update')
  })

  it('marks the session as a transcription session', () => {
    expect(payload.session.type).toBe('transcription')
  })

  it('nests config under audio.input (GA shape), not flat beta fields', () => {
    expect(payload.session.audio.input).toBeDefined()
    // Beta-shape fields must NOT be present at the session level
    expect(payload.session.input_audio_format).toBeUndefined()
    expect(payload.session.input_audio_transcription).toBeUndefined()
  })

  it('requests the streaming whisper model at 24kHz PCM', () => {
    const input = payload.session.audio.input as {
      format: { type: string; rate: number }
      transcription: { model: string }
    }
    expect(input.transcription.model).toBe(STT_MODEL)
    expect(input.format).toEqual({ type: 'audio/pcm', rate: 24_000 })
  })

  it('omits turn_detection (whisper streams continuously; VAD is rejected)', () => {
    const input = payload.session.audio.input as Record<string, unknown>
    expect(input.turn_detection).toBeUndefined()
  })
})

describe('translateOpenAiEvent', () => {
  it('maps transcription deltas to interim text', () => {
    expect(translateOpenAiEvent({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'hello',
    })).toEqual({ type: 'interim', text: 'hello' })
  })

  it('maps completed transcriptions to final text', () => {
    expect(translateOpenAiEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello world',
    })).toEqual({ type: 'final', text: 'hello world' })
  })

  it('maps transcription failures to error with the OpenAI message', () => {
    expect(translateOpenAiEvent({
      type: 'conversation.item.input_audio_transcription.failed',
      error: { message: 'insufficient_quota' },
    })).toEqual({ type: 'error', message: 'insufficient_quota' })
  })

  it('maps top-level errors (e.g. beta_api_shape_disabled) to error messages', () => {
    expect(translateOpenAiEvent({
      type: 'error',
      error: { code: 'beta_api_shape_disabled', message: 'The Realtime Beta API is no longer supported.' },
    })).toEqual({ type: 'error', message: 'The Realtime Beta API is no longer supported.' })
  })

  it('ignores lifecycle noise (VAD, session acks, item creation)', () => {
    for (const type of [
      'input_audio_buffer.speech_started',
      'input_audio_buffer.speech_stopped',
      'input_audio_buffer.committed',
      'conversation.item.created',
      'session.created',
      'session.updated',
    ]) {
      expect(translateOpenAiEvent({ type })).toBeNull()
    }
  })

  it('tolerates missing fields', () => {
    expect(translateOpenAiEvent({ type: 'conversation.item.input_audio_transcription.delta' }))
      .toEqual({ type: 'interim', text: '' })
    expect(translateOpenAiEvent({ type: 'error' }))
      .toEqual({ type: 'error', message: 'Transcription error' })
    expect(translateOpenAiEvent({})).toBeNull()
  })
})
