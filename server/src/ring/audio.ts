// The first seconds of an archived ring recording, as a small mono MP3 —
// what the head re-hearing (pipeline.ts `decide`) sends to hub STT. Read
// from the archived FILE, not the upload buffer: the ring's M4A keeps its
// moov atom at the end, which ffmpeg cannot demux from a pipe.

import { execFile } from 'node:child_process'

/** Long enough for "<verb> <target>" plus the first payload words to anchor
 *  on, short enough to transcribe in a second or two. */
export const HEAD_SECONDS = 10

export function audioHead(path: string, seconds = HEAD_SECONDS): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-i', path, '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', 'pipe:1']
    execFile('ffmpeg', args, { encoding: 'buffer', maxBuffer: 8 << 20, timeout: 15_000 }, (err, stdout) => {
      if (err) { console.warn(`[ring] ffmpeg head cut failed: ${err.message.slice(0, 200)}`); resolve(null); return }
      resolve(stdout.length ? stdout : null)
    })
  })
}

/** Duration of the archived recording in ms; null when ffprobe can't read it. */
export function audioDurationMs(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]
    execFile('ffprobe', args, { encoding: 'utf8', timeout: 15_000 }, (err, stdout) => {
      if (err) { console.warn(`[ring] ffprobe duration failed: ${err.message.slice(0, 200)}`); resolve(null); return }
      const secs = Number(stdout.trim())
      resolve(Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null)
    })
  })
}
