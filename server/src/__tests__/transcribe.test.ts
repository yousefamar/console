import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from '../al/transcribe.js'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.restoreAllMocks()
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('transcribeAudio', () => {
  it('returns null when neither OPENAI_API_KEY nor GEMINI_API_KEY is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const text = await transcribeAudio(Buffer.from('fake-audio'), 'audio/ogg')
    expect(text).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('prefers Whisper when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.GEMINI_API_KEY = 'gemini-test'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello from whisper' }),
    } as Response)
    const text = await transcribeAudio(Buffer.from('fake-audio'), 'audio/ogg')
    expect(text).toBe('hello from whisper')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain('api.openai.com')
  })

  it('falls back to Gemini when only GEMINI_API_KEY is set', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }] }),
    } as Response)
    const text = await transcribeAudio(Buffer.from('fake-audio'), 'audio/ogg')
    expect(text).toBe('hello from gemini')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain('generativelanguage.googleapis.com')
  })

  it('falls back to Gemini when Whisper fails', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.GEMINI_API_KEY = 'gemini-test'
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) } as Response
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini saved it' }] } }] }) } as Response
    })
    const text = await transcribeAudio(Buffer.from('fake-audio'), 'audio/ogg')
    expect(text).toBe('gemini saved it')
    expect(call).toBe(2)
  })

  it('returns null (never throws) when both providers fail', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.GEMINI_API_KEY = 'gemini-test'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)
    const text = await transcribeAudio(Buffer.from('fake-audio'), 'audio/ogg')
    expect(text).toBeNull()
  })
})
