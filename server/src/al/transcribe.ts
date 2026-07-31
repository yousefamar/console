// Batch audio transcription for inbound WhatsApp voice notes. OpenAI
// preferred (same API + model the /stt batch endpoint in index.ts uses for
// dictation); Gemini is a fallback when only GEMINI_API_KEY is set.
// Never throws — a transcription failure must not break inbound delivery of
// the audio file itself; callers get null and just skip the transcript line.

import { STT_BATCH_MODEL } from '../stt.js'

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

async function transcribeWithOpenAi(buf: Buffer, mimeType: string, apiKey: string): Promise<string | null> {
  const filename = `audio.${extFromMime(mimeType)}`
  const formBoundary = '----FormBoundary' + Date.now()
  const formBody = Buffer.concat([
    Buffer.from(`--${formBoundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType.split(';')[0]}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${formBoundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${STT_BATCH_MODEL}\r\n--${formBoundary}--\r\n`),
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
  const json = (await res.json()) as { text?: string }
  return json.text?.trim() || null
}

async function transcribeWithGemini(buf: Buffer, mimeType: string, apiKey: string): Promise<string | null> {
  const model = 'gemini-2.0-flash'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Transcribe this audio verbatim. Return ONLY the transcript text, no commentary, no quotes.' },
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
 *  (GEMINI_API_KEY) fallback. Returns null if neither key is set, or on any
 *  failure — never throws. */
export async function transcribeAudio(buf: Buffer, mimeType: string): Promise<string | null> {
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    try {
      const text = await transcribeWithOpenAi(buf, mimeType, openaiKey)
      if (text) return text
    } catch (err) {
      console.warn('[al/transcribe] OpenAI failed:', (err as Error)?.message)
    }
  }
  const geminiKey = process.env.GEMINI_API_KEY
  if (geminiKey) {
    try {
      const text = await transcribeWithGemini(buf, mimeType, geminiKey)
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
