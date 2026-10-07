// Bringing a remote session's transcript home.
//
// `--resume` reads ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl, and
// so do the recall index (recall/index.ts) and project discovery (projects.ts).
// A remote fork writes that file on FORGE, which means without this module:
//   - `con agent search` / `con agent read` are blind to every remote fork, and
//   - the hub cannot see its own fleet's history.
//
// The live file deliberately stays on forge's local disk rather than on the
// sshfs mount: a FUSE blip mid-turn would corrupt the one file that makes a
// session resumable. Instead the hub pulls it at each turn end, which it
// already has a precise signal for.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ForgeConfig } from './config.js'

const execFileP = promisify(execFile)

/** The CLI's project-dir encoding: every non-alphanumeric becomes '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(cwd: string, claudeSessionId: string, home = homedir()): string {
  return join(home, '.claude', 'projects', encodeProjectDir(cwd), `${claudeSessionId}.jsonl`)
}

/** Pull one session's JSONL from forge to the identical local path.
 *
 *  `--append-verify` is deliberate: a transcript only ever grows, so rsync
 *  ships the tail rather than the whole file (these reach hundreds of MB on a
 *  long card) while still checksum-verifying what it appended to. */
export async function syncTranscript(cfg: ForgeConfig, cwd: string, claudeSessionId: string, log: (m: string) => void = () => {}): Promise<boolean> {
  const remote = transcriptPath(cwd, claudeSessionId, '/home/amar')
  const local = transcriptPath(cwd, claudeSessionId)
  try {
    mkdirSync(join(local, '..'), { recursive: true })
  } catch { /* already there */ }
  const extra = [`${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  const merged = [...new Set([...extra, ...(process.env.PATH ?? '').split(':')])].filter(Boolean)
  try {
    await execFileP('rsync', ['-z', '--append-verify', '-e', 'ssh -o BatchMode=yes', `${cfg.host}:${remote}`, local], {
      env: { ...process.env, PATH: merged.join(':') },
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return true
  } catch (err) {
    // A transcript that has not been created yet (fork spawned, no turn
    // finished) is the normal case before the first result — not an error.
    const msg = (err as Error).message ?? ''
    if (/No such file or directory/i.test(msg)) return false
    log(`[forge] transcript sync failed for ${claudeSessionId}: ${msg.split('\n')[0]}`)
    return false
  }
}

/** Push one session's JSONL the OTHER way — desktop to forge.
 *
 *  This is what makes `con agent forge move` possible: `--resume <csid>` reads
 *  the transcript from the local disk of whatever machine runs `claude`, so a
 *  session that has been talking locally has no history on forge at all. Move
 *  the file first, and the resume there picks the conversation up mid-sentence.
 *
 *  Whole-file, not `--append-verify`: the remote copy is either absent or a
 *  stale prefix from an earlier stint on the box, and getting this wrong costs
 *  the conversation. Transcripts are a few MB compressed. */
export async function pushTranscript(cfg: ForgeConfig, cwd: string, claudeSessionId: string, log: (m: string) => void = () => {}): Promise<boolean> {
  const local = transcriptPath(cwd, claudeSessionId)
  const remote = transcriptPath(cwd, claudeSessionId, '/home/amar')
  if (!existsSync(local)) {
    log(`[forge] no local transcript for ${claudeSessionId} — nothing to push`)
    return false
  }
  const extra = [`${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  const merged = [...new Set([...extra, ...(process.env.PATH ?? '').split(':')])].filter(Boolean)
  const env = { ...process.env, PATH: merged.join(':') }
  try {
    // rsync does not create missing parent dirs on the far side.
    await execFileP('ssh', ['-o', 'BatchMode=yes', cfg.host, `mkdir -p '${remote.replace(/\/[^/]+$/, '')}'`], { env, timeout: 60_000 })
    await execFileP('rsync', ['-z', '-e', 'ssh -o BatchMode=yes', local, `${cfg.host}:${remote}`], {
      env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    })
    return true
  } catch (err) {
    log(`[forge] transcript push failed for ${claudeSessionId}: ${((err as Error).message ?? '').split('\n')[0]}`)
    return false
  }
}

/** Re-pull after a size mismatch: `--append-verify` refuses when the local tail
 *  disagrees with the remote (a rewritten transcript, e.g. after a compaction),
 *  in which case the whole file is fetched. */
export async function resyncTranscriptWhole(cfg: ForgeConfig, cwd: string, claudeSessionId: string): Promise<boolean> {
  const remote = transcriptPath(cwd, claudeSessionId, '/home/amar')
  const local = transcriptPath(cwd, claudeSessionId)
  const extra = [`${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
  const merged = [...new Set([...extra, ...(process.env.PATH ?? '').split(':')])].filter(Boolean)
  return execFileP('rsync', ['-z', '-e', 'ssh -o BatchMode=yes', `${cfg.host}:${remote}`, local], {
    env: { ...process.env, PATH: merged.join(':') }, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
  }).then(() => true).catch(() => false)
}
