import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { toVoiceNote } from '../al/whatsapp.js'
import { speakable } from '../al/tts.js'

// 3 s of 440 Hz, silent for the middle second — enough to see the waveform
// track amplitude and the duration round correctly.
function testWav(): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-af', "volume='if(between(t,1,2),0,1)':eval=frame", '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'],
    { maxBuffer: 16 * 1024 * 1024 })
}

describe('toVoiceNote', () => {
  it('converts any audio to mono ogg/opus with a 64-bucket waveform and whole-second duration', async () => {
    const { ogg, seconds, waveform } = await toVoiceNote(testWav())
    expect(ogg.subarray(0, 4).toString()).toBe('OggS')
    expect(ogg.includes(Buffer.from('OpusHead'))).toBe(true)
    expect(seconds).toBe(3)
    expect(waveform).toHaveLength(64)
    const loud = Array.from(waveform.subarray(4, 18))
    const quiet = Array.from(waveform.subarray(24, 40))
    expect(Math.max(...waveform)).toBe(100)
    expect(Math.min(...loud)).toBeGreaterThan(50)
    expect(Math.max(...quiet)).toBeLessThan(5)
  })

  it('rejects non-audio input', async () => {
    await expect(toVoiceNote(Buffer.from('not audio'))).rejects.toThrow()
  })
})

describe('speakable', () => {
  it('turns typography into spoken pauses and strips markdown', () => {
    expect(speakable('Two things — first · second → done & dusted…')).toBe('Two things, first, second to done and dusted...')
    expect(speakable('**bold** and `code` and "quoted"')).toBe('bold and code and quoted')
  })
})
