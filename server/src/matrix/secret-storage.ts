// Secret Storage v1 AES-HMAC-SHA2, per
// https://spec.matrix.org/v1.11/client-server-api/#msecret_storagev1aes-hmac-sha2
//
// Used to unlock the backup decryption key (stored as an encrypted secret in
// account_data) with the user's recovery key. Intentionally no persistence —
// callers hold the derived material only as long as they need it.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

function deriveKeys(seed: Uint8Array, name: string): { aesKey: Buffer; hmacKey: Buffer } {
  const salt = Buffer.alloc(32) // zero salt per spec
  const info = Buffer.from(name, 'utf-8')
  const okm = Buffer.from(hkdfSync('sha256', seed, salt, info, 64))
  return { aesKey: okm.subarray(0, 32), hmacKey: okm.subarray(32, 64) }
}

/**
 * Verify that `seed` unlocks the given SSSS key description block. Works by
 * encrypting 32 zero bytes with the derived AES key and checking the HMAC
 * matches the stored `mac`. The IV is supplied by the server (it was used
 * when the key was first set up).
 */
export function verifySsssKey(
  seed: Uint8Array,
  keyBlock: { iv?: string; mac?: string },
): boolean {
  if (!keyBlock.iv || !keyBlock.mac) return false
  const { aesKey, hmacKey } = deriveKeys(seed, '')
  const iv = Buffer.from(keyBlock.iv, 'base64')
  if (iv.length !== 16) return false
  const zero = Buffer.alloc(32)
  const cipher = createCipheriv('aes-256-ctr', aesKey, iv)
  const ct = Buffer.concat([cipher.update(zero), cipher.final()])
  const mac = createHmac('sha256', hmacKey).update(ct).digest()
  const expected = Buffer.from(keyBlock.mac, 'base64')
  return expected.length === mac.length && timingSafeEqual(mac, expected)
}

/**
 * Decrypt a secret from an `encrypted[keyId]` block in account_data. Returns
 * the plaintext as a UTF-8 string (for m.megolm_backup.v1 this is the base64
 * of the 32-byte BackupDecryptionKey seed).
 */
export function decryptSsssSecret(
  seed: Uint8Array,
  secretName: string,
  encBlock: { iv: string; ciphertext: string; mac: string },
): string {
  const { aesKey, hmacKey } = deriveKeys(seed, secretName)
  const iv = Buffer.from(encBlock.iv, 'base64')
  const ct = Buffer.from(encBlock.ciphertext, 'base64')
  const mac = Buffer.from(encBlock.mac, 'base64')
  const expectedMac = createHmac('sha256', hmacKey).update(ct).digest()
  if (expectedMac.length !== mac.length || !timingSafeEqual(mac, expectedMac)) {
    throw new Error(`SSSS MAC mismatch for secret ${secretName} (wrong recovery key or secret tampered)`)
  }
  const decipher = createDecipheriv('aes-256-ctr', aesKey, iv)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf-8')
}
