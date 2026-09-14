// Text → speech in Yousef's cloned voice (Cartesia). Ported from the Astera
// demo-video harness (astera-app/scripts/demo/lib/tts.ts): same account, same
// voice clone, same request shape — minus the on-disk cache (a voice note is
// spoken once).
//
// Config: ~/.config/console/cartesia.env — CARTESIA_API_KEY, CARTESIA_VOICE_ID,
// optional CARTESIA_MODEL (default sonic-3.6) and CARTESIA_SPEED (0.6–1.5).
// The voice is cloned from English but speaks any Cartesia language: pass the
// language of the TRANSCRIPT (`ar` for Arabic — dialect comes from the words).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface TtsConfig {
  apiKey: string
  voiceId: string
  model: string
  speed: number
}

export function loadTtsConfig(): TtsConfig | null {
  const file = join(homedir(), '.config/console/cartesia.env')
  const env: Record<string, string> = {}
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m) env[m[1]!] = m[2]!.replace(/^"|"$/g, '')
    }
  }
  const apiKey = process.env.CARTESIA_API_KEY ?? env.CARTESIA_API_KEY
  const voiceId = process.env.CARTESIA_VOICE_ID ?? env.CARTESIA_VOICE_ID
  if (!apiKey || !voiceId) return null
  return {
    apiKey,
    voiceId,
    model: process.env.CARTESIA_MODEL ?? env.CARTESIA_MODEL ?? 'sonic-3.6',
    speed: Number(process.env.CARTESIA_SPEED ?? env.CARTESIA_SPEED ?? 1),
  }
}

/** Typographic separators become spoken pauses; Cartesia normalises numbers, currency and times itself. */
export function speakable(text: string): string {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s*·\s*/g, ', ')
    .replace(/→/g, ' to ')
    .replace(/&/g, ' and ')
    .replace(/…/g, '...')
    .replace(/["“”*_`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .trim()
}

export interface SpeakOptions {
  language?: string
  speed?: number
}

/** Synthesise `text` to a 44.1 kHz mono 16-bit WAV. Retries 429/5xx with back-off. */
export async function synthesise(text: string, opts: SpeakOptions = {}, cfg = loadTtsConfig()): Promise<Buffer> {
  if (!cfg) throw new Error('Cartesia not configured (~/.config/console/cartesia.env: CARTESIA_API_KEY + CARTESIA_VOICE_ID)')
  const spoken = speakable(text)
  if (!spoken) throw new Error('nothing to speak')
  const speed = opts.speed ?? cfg.speed
  let res: Response | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'X-API-Key': cfg.apiKey,
        'Cartesia-Version': '2026-08-14',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: cfg.model,
        transcript: spoken,
        voice: { mode: 'id', id: cfg.voiceId },
        language: opts.language ?? 'en',
        output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
        ...(speed !== 1 ? { generation_config: { speed } } : {}),
      }),
    })
    if (res.ok) break
    if (res.status !== 429 && res.status < 500) break
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt))
  }
  if (!res || !res.ok) throw new Error(`cartesia ${res?.status}: ${(await res?.text())?.slice(0, 300)}`)
  return Buffer.from(await res.arrayBuffer())
}
