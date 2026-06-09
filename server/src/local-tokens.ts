// Local plaintext bearer cache for same-machine clients (CLI + Al).
//
// The hub never stores plaintext bearers — only sha256 hashes. But the CLI
// and Al run as the same unix user on the same machine, so a 0600 sidecar
// file is a fine place to keep plaintext copies they can read at startup.
// When enforcement flips on later, having these tokens already on disk and
// minted at hub boot avoids any chicken-and-egg dance.
//
// File: ~/.config/console/local-tokens.json
// Shape: { cli?: string, al?: string, mintedAt?: number, version: 1 }

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AuthStore, HubTokenScope } from './auth-store.js'

const CONFIG_DIR = join(homedir(), '.config', 'console')
const LOCAL_TOKENS_FILE = join(CONFIG_DIR, 'local-tokens.json')

interface LocalTokensFile {
  version: 1
  mintedAt?: number
  cli?: string
  al?: string
}

function loadLocalTokens(): LocalTokensFile {
  try {
    if (existsSync(LOCAL_TOKENS_FILE)) {
      const parsed = JSON.parse(readFileSync(LOCAL_TOKENS_FILE, 'utf8')) as Partial<LocalTokensFile>
      if (parsed.version === 1) return parsed as LocalTokensFile
    }
  } catch {
    // fall through — file corrupted or unreadable, rebuild
  }
  return { version: 1 }
}

function saveLocalTokens(file: LocalTokensFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(LOCAL_TOKENS_FILE, JSON.stringify(file, null, 2), 'utf8')
  try {
    chmodSync(LOCAL_TOKENS_FILE, 0o600)
  } catch {
    // chmod may fail on non-unix or NFS
  }
}

/**
 * Test if a plaintext bearer still validates against any live (non-revoked)
 * token of the expected scope. If the auth store was rebuilt or the matching
 * token was revoked we treat the cached plaintext as dead and re-mint.
 */
function isPlaintextStillValid(plaintext: string, scope: HubTokenScope, store: AuthStore): boolean {
  if (!plaintext) return false
  const matched = store.validateHubToken(plaintext)
  return !!matched && matched.scope === scope
}

/**
 * Ensure plaintext bearers for the CLI and Al consumers exist on disk and
 * still validate against the hub's auth store. Mints fresh tokens as needed.
 * Idempotent and safe to call at every hub boot.
 *
 * Returns the resolved plaintexts so the caller can log or react.
 */
export function ensureLocalTokens(store: AuthStore): { cli: string; al: string } {
  const file = loadLocalTokens()
  let dirty = false

  const scopes: Array<{ scope: HubTokenScope; key: 'cli' | 'al'; name: string }> = [
    { scope: 'cli', key: 'cli', name: 'local-cli' },
    { scope: 'al', key: 'al', name: 'local-al' },
  ]

  for (const { scope, key, name } of scopes) {
    const existing = file[key]
    if (existing && isPlaintextStillValid(existing, scope, store)) continue

    // Either no plaintext on disk or it no longer validates. Mint a new one.
    const { plaintext } = store.createHubToken(name, scope)
    file[key] = plaintext
    file.mintedAt = Date.now()
    dirty = true
    console.log(`[local-tokens] minted ${scope} token (${name})`)
  }

  if (dirty) saveLocalTokens(file)

  return { cli: file.cli!, al: file.al! }
}

/** Read the plaintext bearer for a known scope from the on-disk cache. */
export function readLocalToken(scope: 'cli' | 'al'): string | null {
  const file = loadLocalTokens()
  return file[scope] ?? null
}

export const LOCAL_TOKENS_PATH = LOCAL_TOKENS_FILE
