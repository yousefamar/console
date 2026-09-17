// Batch audio transcription for inbound WhatsApp voice notes. OpenAI
// preferred (same API + model the /stt batch endpoint in index.ts uses for
// dictation); Gemini is a fallback when only GEMINI_API_KEY is set.
// Never throws — a transcription failure must not break inbound delivery of
// the audio file itself; callers get null and just skip the transcript line.

import { STT_BATCH_MODEL, STT_TIMESTAMP_MODEL } from '../stt.js'
import type { TimedWord } from '../ring/voice.js'

function extFromMime(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase()
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/amr': 'amr',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  }
  return map[base] || 'ogg'
}

async function openAiTranscription(buf: Buffer, mimeType: string, apiKey: string, fields: Array<[string, string]>): Promise<Record<string, unknown> | null> {
  const filename = `audio.${extFromMime(mimeType)}`
  const formBoundary = '----FormBoundary' + Date.now()
  const field = (name: string, value: string) => `\r\n--${formBoundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`
  const formBody = Buffer.concat([
    Buffer.from(`--${formBoundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType.split(';')[0]}\r\n\r\n`),
    buf,
    Buffer.from(`${fields.map(([k, v]) => field(k, v)).join('')}\r\n--${formBoundary}--\r\n`),
  ])
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${formBoundary}` },
    body: formBody,
  })
  if (!res.ok) {
    console.warn(`[al/transcribe] OpenAI HTTP ${res.status}`)
    return null
  }
  return (await res.json()) as Record<string, unknown>
}

async function transcribeWithOpenAi(buf: Buffer, mimeType: string, apiKey: string, prompt?: string): Promise<string | null> {
  const json = await openAiTranscription(buf, mimeType, apiKey, [['model', STT_BATCH_MODEL], ...(prompt ? [['prompt', prompt] as [string, string]] : [])])
  const text = json?.text
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

/** Word-level timestamps (seconds from the clip's start) — OpenAI only, the
 *  timestamp model. Null without a key or on any failure; never throws. */
export async function transcribeWords(buf: Buffer, mimeType: string, opts: { prompt?: string } = {}): Promise<TimedWord[] | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  try {
    const json = await openAiTranscription(buf, mimeType, apiKey, [
      ['model', STT_TIMESTAMP_MODEL], ['response_format', 'verbose_json'], ['timestamp_granularities[]', 'word'],
      ...(opts.prompt ? [['prompt', opts.prompt] as [string, string]] : []),
    ])
    const words = json?.words
    if (!Array.isArray(words)) return null
    const out = words
      .filter((w): w is { word: string; start: number; end: number } => !!w && typeof w.word === 'string' && typeof w.start === 'number' && typeof w.end === 'number')
      .map((w) => ({ word: w.word, start: w.start, end: w.end }))
    return out.length ? out : null
  } catch (err) {
    console.warn('[al/transcribe] OpenAI word timestamps failed:', (err as Error)?.message)
    return null
  }
}

async function transcribeWithGemini(buf: Buffer, mimeType: string, apiKey: string, prompt?: string): Promise<string | null> {
  const model = 'gemini-2.0-flash'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: `Transcribe this audio verbatim. Return ONLY the transcript text, no commentary, no quotes.${prompt ? ` Expected vocabulary: ${prompt}` : ''}` },
            { inline_data: { mime_type: mimeType.split(';')[0], data: buf.toString('base64') } },
          ],
        }],
      }),
    },
  )
  if (!res.ok) {
    console.warn(`[al/transcribe] Gemini HTTP ${res.status}`)
    return null
  }
  const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? ''
  return text.trim() || null
}

/** Transcribe an audio buffer. OpenAI (OPENAI_API_KEY) preferred, Gemini
 *  (GEMINI_API_KEY) fallback. `prompt` biases the model toward a vocabulary
 *  (Whisper's `prompt` field). Returns null if neither key is set, or on any
 *  failure — never throws. */
export async function transcribeAudio(buf: Buffer, mimeType: string, opts: { prompt?: string } = {}): Promise<string | null> {
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    try {
      const text = await transcribeWithOpenAi(buf, mimeType, openaiKey, opts.prompt)
      if (text) return text
    } catch (err) {
      console.warn('[al/transcribe] OpenAI failed:', (err as Error)?.message)
    }
  }
  const geminiKey = process.env.GEMINI_API_KEY
  if (geminiKey) {
    try {
      const text = await transcribeWithGemini(buf, mimeType, geminiKey, opts.prompt)
      if (text) return text
    } catch (err) {
      console.warn('[al/transcribe] Gemini failed:', (err as Error)?.message)
    }
  }
  if (!openaiKey && !geminiKey) {
    console.warn('[al/transcribe] no OPENAI_API_KEY or GEMINI_API_KEY set — skipping transcription')
  }
  return null
}
