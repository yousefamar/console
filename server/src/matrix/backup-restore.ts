// Server-side key backup restore via recovery key.
//
// Replaces the browser's "Settings → recovery key" flow that was removed when
// Matrix moved to the hub (CLAUDE.md Known Issues). Given a user-supplied
// recovery key (base58 `EsU…` form), this:
//
//   1. Fetches the active /room_keys/version from the homeserver.
//   2. Decodes the recovery key and checks its public key matches the
//      version's auth_data. If multiple versions exist, walks older versions
//      in turn so users with multiple recovery keys (rotated over time) can
//      restore from any of them.
//   3. Pages through /room_keys/keys, decrypts each Megolm session, and
//      imports them into the hub's OlmMachine via importRoomKeys.
//
// The recovery key itself is NEVER persisted — it lives only on the stack
// during the call.

import type { HubMatrixCrypto } from './crypto.js'
import { verifySsssKey, decryptSsssSecret } from './secret-storage.js'

interface BackupVersion {
  version: string
  algorithm: string
  auth_data: {
    public_key: string
    signatures?: Record<string, Record<string, string>>
  }
  count?: number
  etag?: string
}

interface BackupSessionData {
  first_message_index: number
  forwarded_count: number
  is_verified: boolean
  session_data: {
    ciphertext: string
    ephemeral: string
    mac: string
  }
}

interface BackupKeysResponse {
  rooms: Record<string, {
    sessions: Record<string, BackupSessionData>
  }>
}

interface DecryptedSession {
  algorithm: string
  forwarding_curve25519_key_chain: string[]
  sender_claimed_keys: { ed25519?: string; [k: string]: string | undefined }
  sender_key: string
  session_key: string
}

// Base58 alphabet used by Olm recovery keys (same as Bitcoin/flickr).
const OLM_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(input: string): Uint8Array {
  const alphabet = OLM_ALPHABET
  let num = 0n
  for (const ch of input) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) throw new Error(`invalid base58 character: ${ch}`)
    num = num * 58n + BigInt(idx)
  }
  // Convert bigint to bytes.
  const bytes: number[] = []
  while (num > 0n) {
    bytes.push(Number(num & 0xffn))
    num >>= 8n
  }
  bytes.reverse()
  // Preserve leading zero bytes (each leading '1' in input == one leading 0x00).
  for (const ch of input) {
    if (ch !== '1') break
    bytes.unshift(0)
  }
  return new Uint8Array(bytes)
}

/**
 * Decode an `EsU…`-style Matrix recovery key into its raw 32-byte seed.
 * Format: 2-byte prefix (0x8b 0x01) + 32-byte key + 1-byte XOR parity.
 * Throws with a clear message if the checksum or prefix is wrong.
 */
export function decodeRecoveryKey(recoveryKey: string): Uint8Array {
  const stripped = recoveryKey.replace(/\s+/g, '')
  const raw = base58Decode(stripped)
  if (raw.length !== 35) {
    throw new Error(`recovery key must decode to 35 bytes, got ${raw.length}`)
  }
  if (raw[0] !== 0x8b || raw[1] !== 0x01) {
    throw new Error(`recovery key has wrong prefix: expected 0x8b 0x01, got 0x${raw[0]!.toString(16)} 0x${raw[1]!.toString(16)}`)
  }
  let parity = 0
  for (let i = 0; i < 34; i++) parity ^= raw[i]!
  if (parity !== raw[34]) {
    throw new Error('recovery key checksum mismatch')
  }
  return raw.slice(2, 34)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return Buffer.from(binary, 'binary').toString('base64')
}

async function homeserverGet<T>(homeserver: string, accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${homeserver}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

/**
 * Try to unlock the real backup decryption key from SSSS (Secret Storage).
 * Returns a base64-encoded 32-byte seed on success, or null if the seed
 * doesn't unlock any SSSS key that the backup secret is encrypted under.
 *
 * Users sometimes rotate SSSS — `m.secret_storage.default_key` may point to a
 * NEW key, while older secrets like `m.megolm_backup.v1` remain encrypted
 * under the PREVIOUS key. Accordingly we iterate every keyId under which the
 * backup secret is encrypted and try the recovery seed against each one.
 */
async function tryUnlockBackupKeyViaSsss(
  homeserver: string,
  accessToken: string,
  userId: string,
  seed: Uint8Array,
  log: (msg: string) => void,
): Promise<string | null> {
  const userPath = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data`

  type BackupSecret = { encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }> }
  let backupSecret: BackupSecret
  try {
    backupSecret = await homeserverGet<BackupSecret>(homeserver, accessToken, `${userPath}/m.megolm_backup.v1`)
  } catch (e) {
    log(`[backup-restore] no m.megolm_backup.v1 secret in account_data (${(e as Error).message})`)
    return null
  }
  const keyIds = Object.keys(backupSecret.encrypted ?? {})
  if (keyIds.length === 0) {
    log(`[backup-restore] m.megolm_backup.v1 has no encrypted entries`)
    return null
  }

  type SsssKeyDesc = { algorithm?: string; iv?: string; mac?: string }
  for (const keyId of keyIds) {
    let keyDesc: SsssKeyDesc
    try {
      keyDesc = await homeserverGet<SsssKeyDesc>(
        homeserver,
        accessToken,
        `${userPath}/m.secret_storage.key.${encodeURIComponent(keyId)}`,
      )
    } catch (e) {
      log(`[backup-restore] could not fetch SSSS key ${keyId}: ${(e as Error).message}`)
      continue
    }
    if (keyDesc.algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
      log(`[backup-restore] SSSS key ${keyId} uses unsupported algorithm: ${keyDesc.algorithm}`)
      continue
    }
    if (!verifySsssKey(seed, { iv: keyDesc.iv, mac: keyDesc.mac })) {
      log(`[backup-restore] recovery key does not unlock SSSS key ${keyId}`)
      continue
    }
    log(`[backup-restore] recovery key unlocks SSSS key ${keyId}`)
    const enc = backupSecret.encrypted![keyId]!
    const plaintext = decryptSsssSecret(seed, 'm.megolm_backup.v1', enc)
    return plaintext.trim()
  }
  return null
}

async function listBackupVersions(
  homeserver: string,
  accessToken: string,
): Promise<BackupVersion[]> {
  // Spec exposes only the *current* version at /room_keys/version (GET returns
  // the latest). Older versions can still be read at /room_keys/version/{v}.
  // Walk back: start with latest, then try numeric predecessors until 404.
  const latest = await homeserverGet<BackupVersion>(
    homeserver,
    accessToken,
    '/_matrix/client/v3/room_keys/version',
  )
  const versions = [latest]
  const latestNum = Number(latest.version)
  if (Number.isFinite(latestNum) && latestNum > 1) {
    for (let v = latestNum - 1; v >= 1; v--) {
      try {
        const prev = await homeserverGet<BackupVersion>(
          homeserver,
          accessToken,
          `/_matrix/client/v3/room_keys/version/${v}`,
        )
        versions.push(prev)
      } catch {
        // 404 or gone — stop walking back
        break
      }
    }
  }
  return versions
}

/**
 * Try to match the recovery key against the backup version's public key using
 * matrix-sdk-crypto's BackupDecryptionKey. Returns the instantiated key if the
 * Curve25519 public keys match.
 */
async function tryKeyAgainstVersion(
  mod: typeof import('@matrix-org/matrix-sdk-crypto-wasm'),
  rawSeed: Uint8Array,
  version: BackupVersion,
): Promise<unknown | null> {
  // BackupDecryptionKey has a private constructor; typeof the class can't be
  // used as a generic constraint, so we type the return as unknown and let
  // callers treat it opaquely.
  const key = mod.BackupDecryptionKey.fromBase64(bytesToBase64(rawSeed))
  if (key.megolmV1PublicKey.publicKeyBase64 === version.auth_data.public_key) {
    return key
  }
  key.free()
  return null
}

export interface RestoreResult {
  matchedVersion: string
  totalSessions: number
  decryptedSessions: number
  imported: number
  totalReportedByImport: number
  perRoomDecrypted: Record<string, number>
}

/**
 * Restore Megolm session keys from the homeserver's key backup using the given
 * recovery key. Imports them into the hub's OlmMachine.
 */
export async function restoreFromRecoveryKey(opts: {
  homeserver: string
  accessToken: string
  userId: string
  recoveryKey: string
  hubCrypto: HubMatrixCrypto
  log: (msg: string) => void
}): Promise<RestoreResult> {
  const { homeserver, accessToken, userId, recoveryKey, hubCrypto, log } = opts
  const rawSeed = decodeRecoveryKey(recoveryKey)

  // Lazy-load the WASM module through the same shim the hub crypto uses so
  // we don't pay the cost twice. HubMatrixCrypto.init() has already run.
  const mod = await import('@matrix-org/matrix-sdk-crypto-wasm')

  const versions = await listBackupVersions(homeserver, accessToken)
  log(`[backup-restore] homeserver has ${versions.length} backup version(s): ${versions.map(v => v.version).join(', ')}`)

  // BackupDecryptionKey instances don't expose their class for typing, so we
  // carry them as `any`. They own WASM memory — always .free() when done.
  // Path 1: treat the recovery key as the direct BackupDecryptionKey seed.
  // This is the older "recovery key = backup key" pattern.
  let match: { version: BackupVersion; key: any } | null = null
  for (const v of versions) {
    const k = await tryKeyAgainstVersion(mod, rawSeed, v)
    if (k) { match = { version: v, key: k }; break }
  }

  // Path 2: treat the recovery key as an SSSS secret-storage key that unlocks
  // an encrypted m.megolm_backup.v1 secret in account_data. This is the
  // Element/Beeper default.
  if (!match) {
    const backupB64 = await tryUnlockBackupKeyViaSsss(homeserver, accessToken, userId, rawSeed, log)
    if (backupB64) {
      const key = mod.BackupDecryptionKey.fromBase64(backupB64)
      const serverPub = key.megolmV1PublicKey.publicKeyBase64
      const v = versions.find(ver => ver.auth_data.public_key === serverPub)
      if (!v) {
        key.free()
        throw new Error(`SSSS unlocked a backup key (pub ${serverPub}) but no matching /room_keys/version on the homeserver`)
      }
      match = { version: v, key }
      log(`[backup-restore] SSSS yielded backup key matching version ${v.version}`)
    }
  }

  if (!match) {
    throw new Error(`recovery key does not match any backup version directly (tried versions: ${versions.map(v => v.version).join(', ')}) and does not unlock SSSS`)
  }
  log(`[backup-restore] recovery key matches backup version ${match.version.version}`)

  const backup = await homeserverGet<BackupKeysResponse>(
    homeserver,
    accessToken,
    `/_matrix/client/v3/room_keys/keys?version=${encodeURIComponent(match.version.version)}`,
  )

  const exportEntries: Array<DecryptedSession & { room_id: string; session_id: string }> = []
  const perRoomDecrypted: Record<string, number> = {}
  let totalSessions = 0
  let decryptedSessions = 0

  for (const [roomId, room] of Object.entries(backup.rooms ?? {})) {
    for (const [sessionId, session] of Object.entries(room.sessions ?? {})) {
      totalSessions++
      try {
        const sd = session.session_data
        const plaintext = match.key.decryptV1(sd.ephemeral, sd.mac, sd.ciphertext)
        const parsed = JSON.parse(plaintext) as DecryptedSession
        exportEntries.push({
          algorithm: parsed.algorithm ?? 'm.megolm.v1.aes-sha2',
          forwarding_curve25519_key_chain: parsed.forwarding_curve25519_key_chain ?? [],
          sender_claimed_keys: parsed.sender_claimed_keys ?? {},
          sender_key: parsed.sender_key,
          session_key: parsed.session_key,
          room_id: roomId,
          session_id: sessionId,
        })
        decryptedSessions++
        perRoomDecrypted[roomId] = (perRoomDecrypted[roomId] ?? 0) + 1
      } catch (e) {
        log(`[backup-restore] failed to decrypt session ${roomId}/${sessionId}: ${(e as Error).message}`)
      }
    }
  }

  // Persist the decryption key inside the OlmMachine so ongoing automatic
  // backup checks know it too. Harmless if already present.
  try {
    await hubCrypto.saveBackupDecryptionKey(match.key, match.version.version)
  } catch (e) {
    log(`[backup-restore] saveBackupDecryptionKey failed (non-fatal): ${(e as Error).message}`)
  }

  match.key.free()

  const importResult = await hubCrypto.importRoomKeys(JSON.stringify(exportEntries))

  log(`[backup-restore] decrypted ${decryptedSessions}/${totalSessions} sessions, imported ${importResult.imported}/${importResult.total} into OlmMachine`)

  return {
    matchedVersion: match.version.version,
    totalSessions,
    decryptedSessions,
    imported: importResult.imported,
    totalReportedByImport: importResult.total,
    perRoomDecrypted,
  }
}

// -----------------------------------------------------------------------------
// Cross-signing restore via recovery key.
//
// Beeper bridges reject Olm traffic from devices that aren't signed by the
// user's self-signing key (CLAUDE.md Known Issues). When the hub migrates to
// a new deviceId, it's initially uncross-signed — every E2EE send to a bridged
// room fails with com.beeper.undecryptable_event and the bridge echoes
// FAIL_RETRIABLE.
//
// The three private cross-signing keys live as SSSS-encrypted secrets in
// account_data:
//   m.cross_signing.master         → MSK seed (base64)
//   m.cross_signing.self_signing   → SSK seed (base64)
//   m.cross_signing.user_signing   → USK seed (base64)
//
// We unlock them with the recovery key, import into the OlmMachine, and call
// bootstrapCrossSigning(false) which signs this device with the SSK and queues
// a SignatureUpload. HubMatrixCrypto.restoreCrossSigning drains that request.
// -----------------------------------------------------------------------------

const CROSS_SIGNING_SECRETS = [
  'm.cross_signing.master',
  'm.cross_signing.self_signing',
  'm.cross_signing.user_signing',
] as const

type CrossSigningSecretName = typeof CROSS_SIGNING_SECRETS[number]

async function unlockCrossSigningSecret(
  homeserver: string,
  accessToken: string,
  userId: string,
  seed: Uint8Array,
  secretName: CrossSigningSecretName,
  log: (msg: string) => void,
): Promise<string> {
  const userPath = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data`
  type Secret = { encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }> }
  const secret = await homeserverGet<Secret>(homeserver, accessToken, `${userPath}/${secretName}`)
  const keyIds = Object.keys(secret.encrypted ?? {})
  if (keyIds.length === 0) {
    throw new Error(`${secretName} has no encrypted entries in account_data`)
  }

  type SsssKeyDesc = { algorithm?: string; iv?: string; mac?: string }
  for (const keyId of keyIds) {
    let keyDesc: SsssKeyDesc
    try {
      keyDesc = await homeserverGet<SsssKeyDesc>(
        homeserver,
        accessToken,
        `${userPath}/m.secret_storage.key.${encodeURIComponent(keyId)}`,
      )
    } catch (e) {
      log(`[xs-restore] could not fetch SSSS key ${keyId}: ${(e as Error).message}`)
      continue
    }
    if (keyDesc.algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
      log(`[xs-restore] SSSS key ${keyId} uses unsupported algorithm: ${keyDesc.algorithm}`)
      continue
    }
    // Some SSSS key descriptions (e.g. Beeper's RII4BrO2Ox) are written without
    // an iv+mac verification block. In that case verifySsssKey can't tell us
    // anything — just attempt the decrypt directly; decryptSsssSecret throws
    // on MAC mismatch, which tells us the seed was wrong.
    const hasVerification = !!(keyDesc.iv && keyDesc.mac)
    if (hasVerification && !verifySsssKey(seed, { iv: keyDesc.iv, mac: keyDesc.mac })) continue
    const enc = secret.encrypted![keyId]!
    try {
      const pt = decryptSsssSecret(seed, secretName, enc).trim()
      log(`[xs-restore] recovery key unlocks ${secretName} under SSSS key ${keyId}${hasVerification ? '' : ' (no-verify-block path)'}`)
      return pt
    } catch (e) {
      log(`[xs-restore] decrypt of ${secretName} under SSSS key ${keyId} failed: ${(e as Error).message}`)
      continue
    }
  }
  throw new Error(`recovery key does not unlock ${secretName} (tried keyIds: ${keyIds.join(', ')})`)
}

export interface CrossSigningRestoreResult {
  status: Record<string, unknown>
}

/**
 * Fetch the three cross-signing secrets from account_data, decrypt them with
 * the recovery key, import into the OlmMachine, and sign this device with the
 * imported self-signing key.
 */
export async function restoreCrossSigningFromRecoveryKey(opts: {
  homeserver: string
  accessToken: string
  userId: string
  recoveryKey: string
  hubCrypto: HubMatrixCrypto
  log: (msg: string) => void
}): Promise<CrossSigningRestoreResult> {
  const { homeserver, accessToken, userId, recoveryKey, hubCrypto, log } = opts
  const seed = decodeRecoveryKey(recoveryKey)

  const [msk, ssk, usk] = await Promise.all([
    unlockCrossSigningSecret(homeserver, accessToken, userId, seed, 'm.cross_signing.master', log),
    unlockCrossSigningSecret(homeserver, accessToken, userId, seed, 'm.cross_signing.self_signing', log),
    unlockCrossSigningSecret(homeserver, accessToken, userId, seed, 'm.cross_signing.user_signing', log),
  ])
  log(`[xs-restore] decrypted MSK/SSK/USK from account_data`)

  const { status } = await hubCrypto.restoreCrossSigning(msk, ssk, usk, homeserver, accessToken)
  return { status }
}
