// con mic — push-to-talk mic ownership + capture.
//
// Ownership lives hub-side (server/src/mic.ts): a single owner session
// receives PTT transcripts, default Al, sticky until reassigned. The `ptt`
// verb is the desktop hold-to-talk driver wired to Sway super+c:
//   bindsym --no-repeat $mod+c exec con mic ptt start
//   bindsym --release      $mod+c exec con mic ptt stop
// `start` records mic audio (detached, outlives the Sway exec); `stop`
// finalizes, transcribes via the hub /stt, and routes the text to the owner.

import { execFile, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hubFetch, getHubUrl, getHubToken } from '../client.js'
import { output, exitWithError, type GlobalFlags } from '../output.js'

const WAV = join(tmpdir(), 'con-ptt.wav')
const PIDFILE = join(tmpdir(), 'con-ptt.pid')

export async function mic(verb: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  switch (verb) {
    case undefined:
    case 'status': {
      const r = await hubFetch<unknown>('/mic/status')
      output(r, flags)
      return
    }
    case 'give':
    case 'pass': {
      const target = args[0]
      if (!target) { exitWithError('USAGE', `Usage: con mic ${verb} <session-name|id|agentKey>  (or "al" to reset)`, flags); return }
      const r = await hubFetch<unknown>('/mic/owner', { method: 'POST', body: { target } })
      output(r, flags)
      return
    }
    case 'release': {
      const r = await hubFetch<unknown>('/mic/owner', { method: 'POST', body: { target: 'al' } })
      output(r, flags)
      return
    }
    case 'say': {
      const text = args.join(' ').trim()
      if (!text) { exitWithError('USAGE', 'Usage: con mic say <text>', flags); return }
      const r = await hubFetch<unknown>('/mic/say', { method: 'POST', body: { text } })
      output(r, flags)
      return
    }
    case 'ptt': {
      const sub = args[0]
      if (sub === 'start') return pttStart(flags)
      if (sub === 'stop') return pttStop(flags)
      exitWithError('USAGE', 'Usage: con mic ptt start | con mic ptt stop', flags)
      return
    }
    default:
      exitWithError('USAGE', `Unknown mic command: ${verb}. Try: status, give, pass, release, say, ptt.`, flags)
  }
}

async function pttStart(flags: GlobalFlags): Promise<void> {
  // Kill any stale recorder first (a missed `stop`, e.g. after a crash).
  killRecorder()
  // pw-record writes a WAV when the target ends in .wav. 16 kHz mono is plenty
  // for speech and keeps the upload small. Detached so it outlives this exec.
  const proc = spawn('pw-record', ['--rate', '16000', '--channels', '1', WAV], {
    detached: true,
    stdio: 'ignore',
  })
  proc.unref()
  if (proc.pid) writeFileSync(PIDFILE, String(proc.pid), 'utf8')
  await hubFetch('/mic/hot', { method: 'POST', body: { hot: true } }).catch(() => {})
  output({ ok: true, recording: true, pid: proc.pid }, flags)
}

async function pttStop(flags: GlobalFlags): Promise<void> {
  killRecorder()
  await hubFetch('/mic/hot', { method: 'POST', body: { hot: false } }).catch(() => {})
  // Give pw-record a beat to flush the WAV header/tail after SIGINT.
  await new Promise((r) => setTimeout(r, 250))
  if (!existsSync(WAV) || safeSize(WAV) < 1024) {
    output({ ok: true, skipped: 'no audio captured' }, flags)
    return
  }
  // Upload via curl -F (multipart with the real .wav filename so Whisper picks
  // the format correctly). hubFetch can't do multipart.
  const text = await transcribe().catch((e: Error) => { exitWithError('ERROR', `transcription failed: ${e.message}`, flags); return '' })
  if (!text.trim()) { output({ ok: true, transcript: '' }, flags); return }
  const r = await hubFetch<unknown>('/mic/say', { method: 'POST', body: { text } })
  output({ ok: true, transcript: text, routed: r }, flags)
}

function killRecorder(): void {
  if (!existsSync(PIDFILE)) return
  try {
    const pid = parseInt(readFileSync(PIDFILE, 'utf8').trim(), 10)
    if (pid > 0) { try { process.kill(pid, 'SIGINT') } catch { /* already gone */ } }
  } catch { /* ignore */ }
  try { rmSync(PIDFILE) } catch { /* ignore */ }
}

function safeSize(p: string): number {
  try { return statSync(p).size } catch { return 0 }
}

/** POST the recorded WAV to the hub /stt via curl (multipart). Returns text. */
function transcribe(): Promise<string> {
  const url = `${getHubUrl()}/stt`
  const token = getHubToken()
  const curlArgs = ['-sk', '-X', 'POST', '-F', `file=@${WAV};type=audio/wav`]
  if (token) curlArgs.push('-H', `Authorization: Bearer ${token}`)
  curlArgs.push(url)
  return new Promise((resolve, reject) => {
    execFile('curl', curlArgs, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        const parsed = JSON.parse(stdout.toString() || '{}') as { text?: string }
        resolve(parsed.text ?? '')
      } catch (e) {
        reject(new Error(`bad /stt response: ${(e as Error).message}`))
      }
    })
  })
}
