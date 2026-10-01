// AWS Signature Version 4 for the context proxy (agents/context-proxy.ts).
//
// Hand-rolled on node:crypto rather than pulling the AWS SDK in: the hub has
// no other reason to carry it, and the proxy signs one request shape (POST
// JSON to bedrock-runtime). Canonical URI is double-encoded, as SigV4 requires
// for every service except S3 — the inference-profile ARN in the path arrives
// percent-encoded once and must be encoded again for the canonical request.

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignInput {
  method: string
  host: string
  /** Path as it will be sent on the wire (already percent-encoded once). */
  path: string
  query?: string
  headers: Record<string, string>
  body: Buffer
  region: string
  service: string
  credentials: AwsCredentials
  now?: Date
  /** Sign an x-amz-content-sha256 header too (Bedrock accepts either; off for
   *  comparing against AWS's published test vectors, which omit it). */
  contentSha256Header?: boolean
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding — encodeURIComponent plus the characters it leaves alone. */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function canonicalUri(path: string): string {
  const p = path || '/'
  return p.split('/').map((seg) => rfc3986(seg)).join('/')
}

function canonicalQuery(query: string | undefined): string {
  if (!query) return ''
  return query.split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=')
    const k = i < 0 ? kv : kv.slice(0, i)
    const v = i < 0 ? '' : kv.slice(i + 1)
    return [rfc3986(decodeURIComponent(k)), rfc3986(decodeURIComponent(v))] as const
  }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&')
}

function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Returns the headers to send: the input headers plus host, x-amz-date,
 *  x-amz-content-sha256, (x-amz-security-token) and authorization. */
export function signV4(i: SignInput): Record<string, string> {
  const now = i.now ?? new Date()
  const date = amzDate(now)
  const day = date.slice(0, 8)
  const payloadHash = sha256(i.body)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  headers.host = i.host
  headers['x-amz-date'] = date
  if (i.contentSha256Header !== false) headers['x-amz-content-sha256'] = payloadHash
  if (i.credentials.sessionToken) headers['x-amz-security-token'] = i.credentials.sessionToken
  const signedNames = Object.keys(headers).sort()
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]}\n`).join('')
  const signedHeaders = signedNames.join(';')
  const canonicalRequest = [
    i.method.toUpperCase(), canonicalUri(i.path), canonicalQuery(i.query), canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')
  const scope = `${day}/${i.region}/${i.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${i.credentials.secretAccessKey}`, day)
  const kRegion = hmac(kDate, i.region)
  const kService = hmac(kRegion, i.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

/** Parse one profile out of an INI-style AWS credentials/config file body. */
export function parseAwsProfile(ini: string, profile: string): Record<string, string> | null {
  let cur: string | null = null
  let found: Record<string, string> | null = null
  for (const raw of ini.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim()
    if (!line) continue
    const m = /^\[\s*(?:profile\s+)?([^\]]+?)\s*\]$/.exec(line)
    if (m) { cur = m[1]; if (cur === profile) found = found ?? {}; continue }
    if (cur !== profile) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    found![line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
  }
  return found
}

/** Static credentials for an AWS profile from ~/.aws/credentials (then ~/.aws/config).
 *  Env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY win when set. */
export function loadAwsCredentials(profile: string, env: NodeJS.ProcessEnv = process.env): AwsCredentials | null {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN }
  }
  for (const file of [join(homedir(), '.aws', 'credentials'), join(homedir(), '.aws', 'config')]) {
    let ini: string
    try { ini = readFileSync(file, 'utf-8') } catch { continue }
    const p = parseAwsProfile(ini, profile)
    if (p?.aws_access_key_id && p.aws_secret_access_key) {
      return { accessKeyId: p.aws_access_key_id, secretAccessKey: p.aws_secret_access_key, sessionToken: p.aws_session_token }
    }
  }
  return null
}
