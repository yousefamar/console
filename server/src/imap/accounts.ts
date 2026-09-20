// The agent mailboxes the hub watches over IMAP (al@, ceo@, Mai's Yahoo…) are
// configured exactly where `~/exec/al-mail.py` reads them: one
// `~/.config/<name>-mail/.env` per account with MAIL_HOST / MAIL_USER /
// MAIL_PASS. The hub reuses those files verbatim — credentials never move.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ImapAccount {
  /** Short name = the `<name>` in `~/.config/<name>-mail`; what `data.account` carries. */
  name: string
  host: string
  user: string
  pass: string
  port: number
}

/** `KEY=VALUE` lines, matching al-mail.py's `_kv`: one outer quote pair stripped, no escapes. */
export function parseMailEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i < 0 || line.trimStart().startsWith('#')) continue
    const k = line.slice(0, i).trim()
    let v = line.slice(i + 1).trim()
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
    if (k) out[k] = v
  }
  return out
}

export function accountFromEnv(name: string, text: string): ImapAccount | null {
  const kv = parseMailEnv(text)
  if (!kv.MAIL_HOST || !kv.MAIL_USER || !kv.MAIL_PASS) return null
  return { name, host: kv.MAIL_HOST, user: kv.MAIL_USER, pass: kv.MAIL_PASS, port: 993 }
}

/** Every `<configHome>/<name>-mail/.env` with the three required keys, sorted by name. */
export function discoverAccounts(configHome: string): ImapAccount[] {
  if (!existsSync(configHome)) return []
  const out: ImapAccount[] = []
  for (const entry of readdirSync(configHome, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('-mail')) continue
    const file = join(configHome, entry.name, '.env')
    if (!existsSync(file)) continue
    try {
      const acct = accountFromEnv(entry.name.slice(0, -'-mail'.length), readFileSync(file, 'utf8'))
      if (acct) out.push(acct)
    } catch { /* unreadable env → not an account */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
