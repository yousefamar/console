// Pattern-based secret redaction applied to every field before it is indexed.
// Misses secrets in unfamiliar shapes — hygiene for the index, not a guarantee.

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(sk|rk|pk)[-_](live|test|ant|proj|or)?[-_]?[A-Za-z0-9_-]{20,}\b/g, '[redacted key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted aws key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[redacted github token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[redacted slack token]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted google key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted jwt]'],
  [/\b(Authorization|Proxy-Authorization)\s*:\s*(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1: $2 [redacted]'],
  [/\b(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[redacted]@'],
  [/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(["']?)([^\s"',;]{6,})\3/gi, '$1$2$3[redacted]$3'],
]

export function redact(text: string): string {
  if (!text) return text
  let out = text
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl)
  return out
}

const SENSITIVE_PATH = /(^|\/)(\.env(\.[A-Za-z0-9_-]+)?|[^/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|ed25519|ecdsa|dsa)|credentials(\.json)?|auth\.json|local-tokens\.json|\.netrc|\.npmrc|\.pypirc)$/

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH.test(path)
}

export const SENSITIVE_PLACEHOLDER = '[not indexed: sensitive path]'
