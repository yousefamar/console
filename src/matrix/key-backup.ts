/**
 * Matrix key backup restore via SSSS recovery key.
 *
 * Flow:
 *   recovery key (base58) → 32-byte SSSS key
 *     → decrypt m.megolm_backup.v1 account data → backup private key
 *       → BackupDecryptionKey.fromBase64(...)
 *         → download all sessions from /room_keys/keys
 *           → decrypt each → importExportedRoomKeys into OlmMachine
 */

import { BackupDecryptionKey } from '@matrix-org/matrix-sdk-crypto-wasm'
import { getMatrixAccessToken, getMatrixHomeserver } from './auth'
import { getCrypto, trySelfSignAfterKeyImport } from './crypto'

// Matrix base58 alphabet (same as Bitcoin)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros
  let leadingZeros = 0
  for (const b of bytes) {
    if (b === 0) leadingZeros++
    else break
  }

  // Convert byte array to base58
  const digits: number[] = []
  for (const b of bytes) {
    let carry = b
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256
      digits[j] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }

  let result = '1'.repeat(leadingZeros)
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]!]
  }
  return result
}

function base58Decode(input: string): Uint8Array {
  // Standard byte-array base58 decoder (no BigInt)
  let leadingZeros = 0
  for (const c of input) {
    if (c === '1') leadingZeros++
    else break
  }

  const size = Math.ceil(input.length * Math.log(58) / Math.log(256))
  const bytes = new Uint8Array(size)

  for (const c of input) {
    let carry = BASE58_ALPHABET.indexOf(c)
    if (carry < 0) throw new Error('Invalid base58 character: ' + c)
    for (let j = size - 1; j >= 0; j--) {
      carry += 58 * bytes[j]!
      bytes[j] = carry % 256
      carry = Math.floor(carry / 256)
    }
  }

  // Skip leading zeros in computed bytes
  let start = 0
  while (start < size && bytes[start] === 0) start++

  const result = new Uint8Array(leadingZeros + size - start)
  result.set(bytes.slice(start), leadingZeros)
  return result
}

/** Decode a Matrix recovery key (base58 with 0x8B 0x01 prefix + parity) into 32 raw bytes. */
function decodeRecoveryKey(recoveryKey: string): Uint8Array {
  // Strip all non-base58 characters (spaces, newlines, dashes, etc.)
  const stripped = recoveryKey.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '')
  let decoded = base58Decode(stripped)

  // Strip any leading zero padding from over-allocation
  while (decoded.length > 35 && decoded[0] === 0) {
    decoded = decoded.slice(1)
  }
  if (decoded.length !== 35) {
    throw new Error('Recovery key decoded to ' + decoded.length + ' bytes, expected 35 (input: ' + stripped.length + ' chars)')
  }
  if (decoded[0] !== 0x8b || decoded[1] !== 0x01) {
    throw new Error('Invalid recovery key prefix')
  }

  // Verify parity (XOR of all bytes should be 0)
  let parity = 0
  for (let i = 0; i < decoded.length; i++) parity ^= decoded[i]!
  if (parity !== 0) {
    throw new Error('Recovery key parity check failed')
  }

  return decoded.slice(2, 34)
}

/** Encode 32 raw bytes into a Matrix recovery key (base58 with 0x8B 0x01 prefix + parity). */
function encodeRecoveryKey(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('Recovery key must be 32 bytes')

  // Build 35-byte payload: 0x8b 0x01 + 32 bytes + parity
  const payload = new Uint8Array(35)
  payload[0] = 0x8b
  payload[1] = 0x01
  payload.set(key, 2)

  // Parity byte: XOR of first 34 bytes
  let parity = 0
  for (let i = 0; i < 34; i++) parity ^= payload[i]!
  payload[34] = parity

  const encoded = base58Encode(payload)

  // Format as groups of 4, separated by spaces
  const groups: string[] = []
  for (let i = 0; i < encoded.length; i += 4) {
    groups.push(encoded.slice(i, i + 4))
  }
  return groups.join(' ')
}

/** HKDF-SHA-256: derive `length` bytes from key material. */
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/** Decrypt an SSSS-encrypted secret. */
async function ssssDecrypt(
  ssssKey: Uint8Array,
  encrypted: { iv: string; ciphertext: string; mac: string },
  secretName: string,
): Promise<Uint8Array> {
  // Derive 64 bytes via HKDF — info is the secret name per the Matrix spec
  const info = new TextEncoder().encode(secretName)
  const derived = await hkdf(ssssKey, new Uint8Array(0), info, 64)
  const aesKey = derived.slice(0, 32)
  const hmacKey = derived.slice(32, 64)

  const iv = Uint8Array.from(atob(encrypted.iv), (c) => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), (c) => c.charCodeAt(0))
  const expectedMac = Uint8Array.from(atob(encrypted.mac), (c) => c.charCodeAt(0))

  // Verify HMAC-SHA-256
  const hmacCryptoKey = await crypto.subtle.importKey(
    'raw',
    hmacKey as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const computedMac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacCryptoKey, ciphertext as BufferSource))
  if (computedMac.length !== expectedMac.length || !computedMac.every((b, i) => b === expectedMac[i]))
    throw new Error('SSSS MAC verification failed — wrong recovery key?')

  // Decrypt AES-256-CTR
  const aesCryptoKey = await crypto.subtle.importKey(
    'raw',
    aesKey as BufferSource,
    { name: 'AES-CTR' },
    false,
    ['decrypt'],
  )
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv as BufferSource, length: 64 },
    aesCryptoKey,
    ciphertext as BufferSource,
  )
  return new Uint8Array(plaintext)
}

/** Encrypt a secret using SSSS. */
async function ssssEncrypt(
  ssssKey: Uint8Array,
  plaintext: Uint8Array,
  secretName: string,
): Promise<{ iv: string; ciphertext: string; mac: string }> {
  const info = new TextEncoder().encode(secretName)
  const derived = await hkdf(ssssKey, new Uint8Array(0), info, 64)
  const aesKey = derived.slice(0, 32)
  const hmacKey = derived.slice(32, 64)

  // Generate random IV (16 bytes)
  const iv = crypto.getRandomValues(new Uint8Array(16))

  // Encrypt AES-256-CTR
  const aesCryptoKey = await crypto.subtle.importKey(
    'raw', aesKey as BufferSource, { name: 'AES-CTR' }, false, ['encrypt'],
  )
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv as BufferSource, length: 64 }, aesCryptoKey, plaintext as BufferSource,
  ))

  // HMAC-SHA-256 over ciphertext
  const hmacCryptoKey = await crypto.subtle.importKey(
    'raw', hmacKey as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacCryptoKey, ciphertext as BufferSource))

  return {
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...ciphertext)),
    mac: btoa(String.fromCharCode(...mac)),
  }
}

async function matrixPut(path: string, body: unknown): Promise<unknown> {
  const token = getMatrixAccessToken()
  const hs = getMatrixHomeserver()
  if (!token || !hs) throw new Error('Not authenticated to Matrix')

  const res = await fetch(`${hs}${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Matrix API PUT ${path}: ${res.status} ${await res.text()}`)
  return res.json().catch(() => ({}))
}

async function matrixGet(path: string): Promise<unknown> {
  const token = getMatrixAccessToken()
  const hs = getMatrixHomeserver()
  if (!token || !hs) throw new Error('Not authenticated to Matrix')

  const res = await fetch(`${hs}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Matrix API ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

interface BackupVersion {
  version: string
  algorithm: string
  auth_data: { public_key: string }
}

interface BackupRoomsResponse {
  rooms: Record<string, {
    sessions: Record<string, {
      first_message_index: number
      forwarded_count: number
      is_verified: boolean
      session_data: {
        ephemeral: string
        ciphertext: string
        mac: string
      }
    }>
  }>
}

/**
 * Restore all room keys from server backup using the recovery key.
 * Returns the number of keys imported.
 */
export async function restoreKeyBackup(
  recoveryKey: string,
  onProgress?: (imported: number, total: number) => void,
): Promise<number> {
  const machine = getCrypto()
  if (!machine) throw new Error('Crypto not initialized')

  const ssssKey = decodeRecoveryKey(recoveryKey)

  // 1. Get default SSSS key ID
  const userId = localStorage.getItem('matrix_user_id')
  if (!userId) throw new Error('No Matrix user ID')
  const encodedUser = encodeURIComponent(userId)

  const defaultKeyData = await matrixGet(
    `/_matrix/client/v3/user/${encodedUser}/account_data/m.secret_storage.default_key`,
  ) as { key: string }
  const defaultKeyId = defaultKeyData.key

  // 2. Get the encrypted backup key from account data
  const backupSecretData = await matrixGet(
    `/_matrix/client/v3/user/${encodedUser}/account_data/m.megolm_backup.v1`,
  ) as { encrypted: Record<string, { iv: string; ciphertext: string; mac: string }> }

  // Try the default key first, then fall back to any other available key
  // (handles the case where bootstrap overwrote the default SSSS key but the
  // backup is still encrypted under the old one)
  const keyIdsToTry = [defaultKeyId, ...Object.keys(backupSecretData.encrypted).filter(k => k !== defaultKeyId)]
  let backupKeyBytes: Uint8Array | null = null

  for (const keyId of keyIdsToTry) {
    const encrypted = backupSecretData.encrypted[keyId]
    if (!encrypted) continue
    try {
      backupKeyBytes = await ssssDecrypt(ssssKey, encrypted, 'm.megolm_backup.v1')
      break // Decryption succeeded
    } catch {
      // Wrong key — try next
    }
  }

  if (!backupKeyBytes) {
    throw new Error(`Recovery key does not match any SSSS key (tried: ${keyIdsToTry.join(', ')})`)
  }
  const backupKeyBase64 = new TextDecoder().decode(backupKeyBytes)
  const backupDecryptionKey = BackupDecryptionKey.fromBase64(backupKeyBase64)

  // 4. Get backup version
  const backupVersion = await matrixGet(
    '/_matrix/client/v3/room_keys/version',
  ) as BackupVersion

  // 5. Download all backed-up keys
  const allKeys = await matrixGet(
    `/_matrix/client/v3/room_keys/keys?version=${encodeURIComponent(backupVersion.version)}`,
  ) as BackupRoomsResponse

  // 6. Decrypt each session and build import map
  let total = 0
  for (const roomId in allKeys.rooms) {
    total += Object.keys(allKeys.rooms[roomId]!.sessions).length
  }
  // Build array of exported room keys for importExportedRoomKeys
  const exportedKeys: Record<string, unknown>[] = []
  let imported = 0

  for (const roomId in allKeys.rooms) {
    const roomSessions = allKeys.rooms[roomId]!.sessions
    for (const sessionId in roomSessions) {
      const session = roomSessions[sessionId]!
      try {
        const decrypted = backupDecryptionKey.decryptV1(
          session.session_data.ephemeral,
          session.session_data.mac,
          session.session_data.ciphertext,
        )
        const parsed = JSON.parse(decrypted) as Record<string, unknown>
        // Ensure room_id and session_id are set
        parsed.room_id = roomId
        parsed.session_id = sessionId
        // Set algorithm if not present (Megolm)
        if (!parsed.algorithm) parsed.algorithm = 'm.megolm.v1.aes-sha2'
        exportedKeys.push(parsed)
        imported++
        if (onProgress && imported % 50 === 0) {
          onProgress(imported, total)
        }
      } catch (err) {
        // Expected for sessions with different encryption algorithms
      }
    }
  }

  // 7. Import into OlmMachine
  await machine.importExportedRoomKeys(JSON.stringify(exportedKeys), () => {})
  onProgress?.(imported, total)

  // Enable ongoing backup so new keys get backed up too
  const pubKey = backupDecryptionKey.megolmV1PublicKey
  await machine.enableBackupV1(pubKey.publicKeyBase64, backupVersion.version)

  // 8. Import cross-signing keys from SSSS and self-sign device
  try {
    await importCrossSigningKeysFromSSSSAndSign(ssssKey, defaultKeyId, encodedUser)
  } catch (err) {
    // Non-critical — key restore still works without cross-signing
  }

  // 9. Clear cached messages so they get re-fetched and decrypted with new keys
  const { db } = await import('@/db')
  await db.chatMessages.clear()

  return imported
}

/**
 * Import cross-signing keys from SSSS using a recovery key.
 * Standalone entry point for device verification without full key backup restore.
 */
export async function importCrossSigningKeysFromRecoveryKey(recoveryKey: string): Promise<void> {
  const ssssKey = decodeRecoveryKey(recoveryKey)

  const userId = localStorage.getItem('matrix_user_id')
  if (!userId) throw new Error('No Matrix user ID')
  const encodedUser = encodeURIComponent(userId)

  // Get default SSSS key ID
  const defaultKeyData = await matrixGet(
    `/_matrix/client/v3/user/${encodedUser}/account_data/m.secret_storage.default_key`,
  ) as { key: string }

  await importCrossSigningKeysFromSSSSInternal(ssssKey, defaultKeyData.key, encodedUser)
}

/**
 * Import cross-signing private keys from SSSS and self-sign this device.
 * This uses the existing cross-signing keys (e.g. from Beeper) rather than
 * creating new ones, so the bridge continues to trust them.
 */
async function importCrossSigningKeysFromSSSSInternal(
  ssssKey: Uint8Array,
  defaultKeyId: string,
  encodedUser: string,
): Promise<void> {
  const machine = getCrypto()
  if (!machine) return

  // Fetch and decrypt each cross-signing private key from account data
  const keyNames = [
    'm.cross_signing.master',
    'm.cross_signing.self_signing',
    'm.cross_signing.user_signing',
  ] as const

  const decryptedKeys: Record<string, string> = {}

  for (const secretName of keyNames) {
    try {
      const data = await matrixGet(
        `/_matrix/client/v3/user/${encodedUser}/account_data/${secretName}`,
      ) as { encrypted: Record<string, { iv: string; ciphertext: string; mac: string }> }

      const encrypted = data.encrypted[defaultKeyId]
      if (!encrypted) {
        // Key not available for this secret — skip
        continue
      }

      const decrypted = await ssssDecrypt(ssssKey, encrypted, secretName)
      // The decrypted value is base64-encoded private key seed
      decryptedKeys[secretName] = new TextDecoder().decode(decrypted)
    } catch (err) {
      // Secret may not exist or may use a different key
    }
  }

  const masterKey = decryptedKeys['m.cross_signing.master']
  const selfSigningKey = decryptedKeys['m.cross_signing.self_signing']
  const userSigningKey = decryptedKeys['m.cross_signing.user_signing']

  if (!masterKey || !selfSigningKey) {
    throw new Error('Missing cross-signing keys in SSSS (master or self-signing)')
  }

  // Import into OlmMachine
  const status = await machine.importCrossSigningKeys(
    masterKey,
    selfSigningKey,
    userSigningKey ?? null,
  )
  console.log('[key-backup] Cross-signing keys imported:', status.hasMaster, status.hasSelfSigning, status.hasUserSigning)
}

/**
 * Generate a new SSSS key, encrypt cross-signing private keys with it,
 * upload to account_data, and return the new recovery key string.
 * Must be called while cross-signing private keys are still in OlmMachine memory
 * (i.e., right after bootstrap, before page reload).
 */
export async function generateNewRecoveryKey(): Promise<string> {
  const machine = getCrypto()
  if (!machine) throw new Error('Crypto not initialized')

  const userId = localStorage.getItem('matrix_user_id')
  if (!userId) throw new Error('No Matrix user ID')
  const encodedUser = encodeURIComponent(userId)

  // Export cross-signing private keys from OlmMachine
  console.log('[key-backup] Exporting cross-signing keys...')
  const exported = await machine.exportCrossSigningKeys()
  console.log('[key-backup] Export result:', exported ? 'got keys' : 'null')
  if (!exported) throw new Error('No cross-signing keys to export — bootstrap may not have persisted them')
  const masterKey = exported.masterKey
  const selfSigningKey = exported.self_signing_key
  const userSigningKey = exported.userSigningKey
  console.log('[key-backup] Keys:', { hasMaster: !!masterKey, hasSelfSigning: !!selfSigningKey, hasUserSigning: !!userSigningKey })
  exported.free()

  if (!masterKey || !selfSigningKey) {
    throw new Error('Missing master or self-signing key')
  }

  // Generate new 32-byte SSSS key
  const ssssKey = crypto.getRandomValues(new Uint8Array(32))
  const recoveryKeyString = encodeRecoveryKey(ssssKey)

  // Generate a key ID (random 12 chars)
  const keyIdBytes = crypto.getRandomValues(new Uint8Array(9))
  const keyId = btoa(String.fromCharCode(...keyIdBytes)).replace(/[+/=]/g, '').slice(0, 12)

  // Upload SSSS key metadata
  // Compute key passthrough info (iv + mac with empty plaintext for verification)
  await matrixPut(
    `/_matrix/client/v3/user/${encodedUser}/account_data/m.secret_storage.key.${keyId}`,
    {
      algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
    },
  )

  // Set as default key
  await matrixPut(
    `/_matrix/client/v3/user/${encodedUser}/account_data/m.secret_storage.default_key`,
    { key: keyId },
  )

  // Encrypt and upload each cross-signing key
  const keysToStore: [string, string][] = [
    ['m.cross_signing.master', masterKey],
    ['m.cross_signing.self_signing', selfSigningKey],
  ]
  if (userSigningKey) {
    keysToStore.push(['m.cross_signing.user_signing', userSigningKey])
  }

  for (const [secretName, keyBase64] of keysToStore) {
    const plaintext = new TextEncoder().encode(keyBase64)
    const encrypted = await ssssEncrypt(ssssKey, plaintext, secretName)
    await matrixPut(
      `/_matrix/client/v3/user/${encodedUser}/account_data/${secretName}`,
      { encrypted: { [keyId]: encrypted } },
    )
  }

  // Also re-encrypt the backup key if it exists
  try {
    const backupSecretData = await matrixGet(
      `/_matrix/client/v3/user/${encodedUser}/account_data/m.megolm_backup.v1`,
    ) as { encrypted: Record<string, { iv: string; ciphertext: string; mac: string }> }

    // Find any existing encrypted backup key (from old SSSS key)
    const oldKeyIds = Object.keys(backupSecretData.encrypted)
    if (oldKeyIds.length > 0) {
      // Try to decrypt with old key first — but we don't have old key, so just
      // skip re-encrypting the backup key. The backup itself still works, just
      // the backup key won't be restorable from SSSS until a new backup is created.
      console.log('[key-backup] Existing megolm backup key not re-encrypted (old SSSS key needed)')
    }
  } catch {
    // No existing backup key — that's fine
  }

  console.log('[key-backup] New recovery key generated and cross-signing keys uploaded to SSSS')
  return recoveryKeyString
}

async function importCrossSigningKeysFromSSSSAndSign(
  ssssKey: Uint8Array,
  defaultKeyId: string,
  encodedUser: string,
): Promise<void> {
  await importCrossSigningKeysFromSSSSInternal(ssssKey, defaultKeyId, encodedUser)
  // Self-sign this device using the imported keys
  await trySelfSignAfterKeyImport()
}
