// Path constants for the absorbed Al runtime.
//
// Yousef's "Al workspace" — persona, mistakes log, per-user files, workflows,
// call transcripts — stays at `~/.local/share/al/workspace/` (the symlinked
// vault target). Console only READS from there; it never writes back. Writes
// happen via Yousef's Obsidian / shell edits, and changes are picked up the
// next time Al's Console session is restarted (no fs.watch).
//
// Baileys WhatsApp auth state moves into Console's config dir on cutover.
//
// Old layout (al daemon owned):
//   ~/.local/share/al/auth_whatsapp/       Baileys creds + key files
//   ~/.local/share/al/workspace/           Persona + users + workflows + transcripts
//
// New layout (Console hub owns the auth dir; workspace unchanged):
//   ~/.config/console/auth_whatsapp/       Baileys creds + key files (moved)
//   ~/.local/share/al/workspace/           Unchanged — Yousef's vault
//
// The mv is atomic and same-filesystem, so Baileys reconnects without re-QR.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')

/**
 * Legacy "Al data root" — the OLD daemon used `${XDG_DATA_HOME}/al` and
 * symlinked `workspace` into the Obsidian vault. The hub no longer routes
 * file IO through this path; kept as a label for back-compat in case any
 * older script reads it from the environment.
 */
export const AL_HOME = process.env.AL_HOME || join(xdgData, 'al')

/**
 * Persona + users + workflows + call-transcripts. Read at session spawn.
 * Points at the literal vault path rather than the `.local/share/al/workspace`
 * symlink so Al's cwd (and Claude's transcript folder) match the on-disk
 * canonical location with no indirection. Override via AL_WORKSPACE_DIR.
 */
export const WORKSPACE_DIR =
  process.env.AL_WORKSPACE_DIR ||
  join(homedir(), 'sync', 'brain', 'root', 'projects', 'al', 'workspace')

/** Baileys auth state — owned by Console post-cutover. */
export const AUTH_WHATSAPP_DIR = join(homedir(), '.config', 'console', 'auth_whatsapp')

/** Persistent record of which Claude session is "Al". */
export const AL_SESSION_FILE = join(homedir(), '.config', 'console', 'al-session.json')

// NOTE: there is intentionally no OWNER_PHONE / recipient guard here. The old
// standalone daemon restricted *non-owner conversation participants* from
// messaging arbitrary people — a concept that doesn't exist now that Al is a
// single bearer-gated Console session whose actual job is to message contacts
// on Yousef's behalf. Authorization is the hub bearer on /whatsapp/send.

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}
