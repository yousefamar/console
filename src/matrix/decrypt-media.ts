import type { EncryptedFile } from './types'
import { mxcToHttp } from './api'

// Base64url encode (unpadded, URL-safe)
function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Encrypt a file for Matrix E2EE upload (AES-CTR-256, same scheme as decrypt)
export async function encryptAttachment(data: ArrayBuffer): Promise<{ encrypted: ArrayBuffer; file: Omit<EncryptedFile, 'url'> }> {
  // Generate random 256-bit AES key
  const key = await crypto.subtle.generateKey(
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt'],
  )

  // Generate random 128-bit IV (upper 64 bits random, lower 64 bits zero for counter)
  const iv = new Uint8Array(16)
  crypto.getRandomValues(iv.subarray(0, 8))

  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key,
    data,
  )

  // Export key as JWK
  const jwk = await crypto.subtle.exportKey('jwk', key)

  // SHA-256 hash of ciphertext
  const hash = await crypto.subtle.digest('SHA-256', encrypted)

  return {
    encrypted,
    file: {
      key: {
        kty: jwk.kty!,
        key_ops: ['encrypt', 'decrypt'],
        alg: jwk.alg!,
        k: jwk.k!,
        ext: jwk.ext!,
      },
      iv: toBase64Url(iv.buffer as ArrayBuffer),
      hashes: { sha256: toBase64Url(hash) },
      v: 'v2',
    },
  }
}

// Decrypt an encrypted Matrix attachment (AES-CTR-256)
// See: https://spec.matrix.org/v1.6/client-server-api/#extensions-to-mroommessage-msgtypes
export async function decryptAttachment(file: EncryptedFile): Promise<Blob> {
  const httpUrl = mxcToHttp(file.url)
  if (!httpUrl) throw new Error('Cannot convert mxc URL')

  // Download encrypted blob
  const res = await fetch(httpUrl)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const encrypted = await res.arrayBuffer()

  // Import AES key from JWK
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: file.key.kty,
      key_ops: ['decrypt'],
      alg: file.key.alg,
      k: file.key.k,
      ext: file.key.ext,
    },
    { name: 'AES-CTR', length: 256 },
    false,
    ['decrypt'],
  )

  // Decode IV (base64 to ArrayBuffer) — Matrix uses unpadded base64
  const ivBytes = Uint8Array.from(atob(file.iv.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

  // Decrypt with AES-CTR
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: ivBytes, length: 64 },
    key,
    encrypted,
  )

  return new Blob([decrypted])
}
