// `voice <person> …` — the recording ITSELF, minus the spoken command head
// ("voice mum"), goes out as a WhatsApp voice note. Where the head ends is
// found in two passes over the first seconds: hub-STT word timestamps place
// the payload's opening words (±0.25 s in practice — whisper's word starts
// jitter), then the signal's own RMS envelope snaps that estimate to the
// actual quiet gap so the cut clips neither the name nor the first word.
// ffmpeg cuts there and transcodes to ogg/opus, the format WhatsApp voice
// notes are natively. The decision logic is pure; only the exec helpers
// touch ffmpeg.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { wordKey, wordKeys, fuzzyEqual } from './router.js'
import { HEAD_SECONDS } from './audio.js'

const execFileP = promisify(execFile)

export interface TimedWord { word: string; start: number; end: number }
/** One RMS frame of the head clip: start time (s) and level (dBFS, -Infinity for digital silence). */
export interface Frame { t: number; db: number }
export interface VoiceClip { data: Buffer; contentType: string; durationMs: number }
/** Where the payload starts, per the words: `t` is the best guess, `lo`/`hi`
 *  bound the gap between the last head word and the first payload word. */
export interface CutEstimate { t: number; lo: number; hi: number }

export const VOICE_NOTE_MIME = 'audio/ogg'
export const FRAME_MS = 50

/** How many words into the recording the payload may start — a command head
 *  is a handful of words, and a 10 s head clip holds ~25. */
const HEAD_WINDOW = 12
/** Lead kept before the first payload word so its onset is never clipped. */
const ONSET_MARGIN = 0.15
/** How far outside the words' gap the envelope may find the real pause. */
const SNAP_SLACK = 0.35
/** A pause is at least this many quiet frames in a row — 150 ms, longer than
 *  a plosive's closure inside a word. */
const MIN_GAP_FRAMES = 3
/** Lead kept before speech resumes when cutting inside a detected pause. */
const GAP_LEAD = 0.1

/** Where the spoken payload begins, per the timestamped words. The payload's
 *  opening words are located among them (fuzzy, 3 then 2); failing that the
 *  head is assumed to span as many words as the transcript has before the
 *  payload. Null when nothing can be placed (no words, or the payload is the
 *  whole transcript). */
export function payloadStart(words: TimedWord[], transcript: string, payload: string): CutEstimate | null {
  const timed = words.filter((w) => wordKey(w.word))
  const keys = timed.map((w) => wordKey(w.word))
  const want = wordKeys(payload)
  const headCount = wordKeys(transcript).length - want.length
  if (!timed.length || !want.length || headCount <= 0) return null
  for (const n of want.length === 1 ? [1] : [3, 2]) {
    if (n > want.length) continue
    for (let s = 1; s <= Math.min(HEAD_WINDOW, keys.length - n); s++) {
      let ok = true
      for (let j = 0; j < n; j++) if (!fuzzyEqual(keys[s + j]!, want[j]!)) { ok = false; break }
      if (ok) return cutBefore(timed, s)
    }
  }
  return keys.length > headCount ? cutBefore(timed, headCount) : null
}

/** A point in the gap before word `i`: up to ONSET_MARGIN ahead of it, never
 *  more than halfway back to the previous word, never inside it. */
function cutBefore(words: TimedWord[], i: number): CutEstimate {
  const prev = words[i - 1]!
  const next = words[i]!
  const gap = next.start - prev.end
  const t = gap <= 0 ? next.start : next.start - Math.min(ONSET_MARGIN, gap / 2)
  return { t: round3(t), lo: Math.min(prev.end, next.start), hi: next.start }
}

/** Refine a word-timestamp estimate against the signal: the quiet run of
 *  frames that overlaps the words' gap (with some slack) is the real pause,
 *  and the cut goes just before speech resumes in it. Levels are judged
 *  relative to the clip's own quiet floor and typical speech level — ring
 *  recordings are noisy and speech fills most of the head, so the floor is a
 *  low percentile and no dB threshold is fixed. Falls back to the estimate
 *  when the envelope is too short, too flat, or shows no pause near it. */
export function snapToGap(frames: Frame[], est: CutEstimate): number {
  const levels = frames.map((f) => f.db).filter((d) => Number.isFinite(d)).sort((a, b) => a - b)
  if (levels.length < 20) return est.t
  const pct = (p: number) => levels[Math.min(levels.length - 1, Math.floor(p * levels.length))]!
  const noise = pct(0.05)
  const speech = pct(0.7)
  if (speech - noise < 6) return est.t
  const thr = noise + (speech - noise) * 0.4
  const frameS = frames.length > 1 ? frames[1]!.t - frames[0]!.t : FRAME_MS / 1000
  const runs: Array<{ start: number; end: number }> = []
  let run: { start: number; n: number } | null = null
  for (const f of frames) {
    const quiet = !(f.db >= thr)
    if (quiet) { run ??= { start: f.t, n: 0 }; run.n++; continue }
    if (run && run.n >= MIN_GAP_FRAMES) runs.push({ start: run.start, end: f.t })
    run = null
  }
  if (run && run.n >= MIN_GAP_FRAMES) runs.push({ start: run.start, end: run.start + run.n * frameS })
  const lo = est.lo - SNAP_SLACK
  const hi = est.hi + SNAP_SLACK
  let best: { start: number; end: number } | null = null
  let bestScore = -Infinity
  for (const r of runs) {
    if (r.end < lo || r.start > hi) continue
    // Prefer the run covering most of the words' gap; nearest to the estimate on a tie.
    const overlap = Math.max(0, Math.min(r.end, est.hi) - Math.max(r.start, est.lo))
    const score = overlap - Math.abs((r.start + r.end) / 2 - est.t) / 100
    if (score > bestScore) { best = r; bestScore = score }
  }
  if (!best) return est.t
  return round3(Math.max(best.start, best.end - GAP_LEAD))
}

const round3 = (t: number) => Math.round(t * 1000) / 1000

/** RMS level per FRAME_MS frame over the first `seconds` of the recording.
 *  Read from the archived FILE (the ring's M4A is not pipeable). Null when
 *  ffmpeg fails. */
export async function audioEnvelope(path: string, seconds = HEAD_SECONDS): Promise<Frame[] | null> {
  try {
    const filter = `aresample=16000,asetnsamples=n=${16000 * FRAME_MS / 1000},astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-`
    const { stdout } = await execFileP('ffmpeg', ['-v', 'info', '-nostats', '-i', path, '-t', String(seconds), '-af', filter, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 4 << 20, timeout: 15_000 })
    const frames = parseEnvelope(String(stdout))
    return frames.length ? frames : null
  } catch (err) {
    console.warn(`[ring] envelope failed: ${(err as Error).message.slice(0, 200)}`)
    return null
  }
}

/** ametadata's print format: a `frame:… pts_time:<t>` line, then `<key>=<value>`. */
export function parseEnvelope(out: string): Frame[] {
  const frames: Frame[] = []
  let t: number | null = null
  for (const line of out.split('\n')) {
    const pts = /pts_time:\s*(-?[\d.]+)/.exec(line)
    if (pts) { t = parseFloat(pts[1]!); continue }
    const lvl = /RMS_level=(-?[\d.]+|-inf|inf|nan)/.exec(line)
    if (lvl && t !== null) {
      const v = lvl[1]!
      frames.push({ t, db: v === '-inf' ? -Infinity : v === 'inf' ? Infinity : v === 'nan' ? -Infinity : parseFloat(v) })
      t = null
    }
  }
  return frames
}

/** The recording from `fromSeconds` on, as mono ogg/opus. Null when ffmpeg fails. */
export async function cutVoiceNote(path: string, fromSeconds: number): Promise<VoiceClip | null> {
  try {
    const seek = fromSeconds > 0 ? ['-ss', fromSeconds.toFixed(3)] : []
    const [{ stdout }, total] = await Promise.all([
      execFileP('ffmpeg', ['-v', 'error', ...seek, '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 << 20, timeout: 30_000 }),
      audioDurationSeconds(path),
    ])
    if (!stdout.length) return null
    const durationMs = Math.max(0, Math.round(((total ?? fromSeconds) - fromSeconds) * 1000))
    return { data: stdout, contentType: VOICE_NOTE_MIME, durationMs }
  } catch (err) {
    console.warn(`[ring] voice note cut failed: ${(err as Error).message.slice(0, 200)}`)
    return null
  }
}

async function audioDurationSeconds(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8', timeout: 15_000 })
    const secs = parseFloat(String(stdout).trim())
    return Number.isFinite(secs) ? secs : null
  } catch {
    return null
  }
}
