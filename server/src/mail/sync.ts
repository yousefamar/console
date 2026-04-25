// ============================================================================
// Gmail sync loop — runs on the hub, replacing the browser-side polling.
//
// Per account:
//   • On first run (no historyId), do a bounded initial backfill of INBOX.
//   • Thereafter, call users.history.list with the stored historyId. Apply
//     messageAdded / messageDeleted / labelAdded / labelRemoved deltas.
//   • Broadcast deltas on the sync bus as {service:'mail', op:'delta', ...}
//     so connected browsers reconcile their Dexie cache.
//   • When new messages land in INBOX, fire a push notification.
//
// State is persisted per account under ~/.config/console/mail-state.json.
// Enough to survive hub restarts without re-doing the initial backfill.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GmailClient } from '../gmail-client.js'
import type { SyncBus } from '../sync-bus.js'
import type { PushServer } from '../push.js'
import type { AuthStore } from '../auth-store.js'

type MailAccountState = {
  historyId?: string
  lastSyncMs?: number
}
type MailState = Record<string /* account email */, MailAccountState>

export type MailDelta = {
  account: string
  added?: Array<{ threadId: string; messageId: string }>
  removed?: Array<{ messageId: string; threadId?: string }>
  labelChanged?: Array<{ messageId: string; threadId?: string; addedLabels?: string[]; removedLabels?: string[] }>
  historyId: string
}

/** Parse an RFC 5322 `From:` header into {name, email}. Tolerant of missing pieces. */
function parseFrom(raw: string): { name: string; email: string } {
  if (!raw) return { name: '', email: '' }
  // "Display Name" <addr@host> — strip the angle-bracketed addr, trim quotes.
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?)\s*<([^>]+)>\s*$/)
  if (m) return { name: (m[1] ?? '').trim(), email: (m[2] ?? '').trim() }
  // Bare address.
  return { name: '', email: raw.trim() }
}

export class MailSync {
  private state: MailState = {}
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly INTERVAL_MS = 60_000 // 1 min baseline
  private readonly INITIAL_FETCH_LIMIT = 50

  constructor(
    private readonly gmail: GmailClient,
    private readonly auth: AuthStore,
    private readonly bus: SyncBus,
    private readonly push: PushServer,
    private readonly stateFile: string,
    private readonly log: (msg: string) => void,
  ) {
    this.loadState()
  }

  start(): void {
    if (this.timer) return
    this.log('[mail-sync] starting')
    // Run a first sync shortly after boot so we don't block startup.
    setTimeout(() => { this.tick().catch((e) => this.log(`[mail-sync] initial tick failed: ${e}`)) }, 5_000)
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log(`[mail-sync] tick failed: ${e}`))
    }, this.INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Force a sync tick on demand (e.g. via RPC from the browser). */
  async syncNow(): Promise<{ ok: true }> {
    await this.tick()
    return { ok: true }
  }

  // ---- internals ----

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const accounts = await this.listAccounts()
      for (const acct of accounts) {
        try {
          await this.syncAccount(acct)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.log(`[mail-sync] ${acct} failed: ${msg}`)
          this.bus.broadcast('mail', 'error', { account: acct, message: msg })
        }
      }
    } finally {
      this.running = false
    }
  }

  private async listAccounts(): Promise<string[]> {
    return this.auth.getGoogleAccounts().map((a) => a.email)
  }

  private async syncAccount(account: string): Promise<void> {
    const accState = this.state[account] ?? {}
    const previousHistoryId = accState.historyId

    if (!previousHistoryId) {
      // Initial backfill: list N recent threads from INBOX.
      const profile = await this.gmail.getProfile(account).catch(() => null)
      if (!profile) return
      accState.historyId = profile.historyId
      accState.lastSyncMs = Date.now()
      this.state[account] = accState
      this.saveState()
      // Tell browsers to do their own initial IDB hydration; we don't push every
      // old thread over the wire. This is the one place where the browser still
      // drives a Gmail call — via its existing /mail/threads listing — but only
      // at first boot. Subsequent sessions start from the historyId we saved.
      this.bus.broadcast('mail', 'initial', { account, historyId: profile.historyId })
      return
    }

    // Incremental: pull history deltas.
    const delta: MailDelta = { account, added: [], removed: [], labelChanged: [], historyId: previousHistoryId }
    let pageToken: string | undefined
    let nextHistoryId = previousHistoryId
    let pages = 0
    do {
      const resp = await this.gmail.listHistory(previousHistoryId, { account, pageToken })
      nextHistoryId = resp.historyId || nextHistoryId
      for (const entry of (resp.history ?? []) as any[]) {
        for (const a of entry.messagesAdded ?? []) {
          const m = a.message
          if (m?.id && m?.threadId) delta.added!.push({ threadId: m.threadId, messageId: m.id })
        }
        for (const d of entry.messagesDeleted ?? []) {
          const m = d.message
          if (m?.id) delta.removed!.push({ messageId: m.id, threadId: m.threadId })
        }
        for (const la of entry.labelsAdded ?? []) {
          delta.labelChanged!.push({ messageId: la.message?.id, threadId: la.message?.threadId, addedLabels: la.labelIds })
        }
        for (const lr of entry.labelsRemoved ?? []) {
          delta.labelChanged!.push({ messageId: lr.message?.id, threadId: lr.message?.threadId, removedLabels: lr.labelIds })
        }
      }
      pageToken = resp.nextPageToken
      pages++
      if (pages > 10) break // guard
    } while (pageToken)

    const hadChanges = (delta.added!.length + delta.removed!.length + delta.labelChanged!.length) > 0
    delta.historyId = nextHistoryId
    accState.historyId = nextHistoryId
    accState.lastSyncMs = Date.now()
    this.state[account] = accState
    this.saveState()

    if (hadChanges) {
      this.bus.broadcast('mail', 'delta', delta)
      // Fire notification for newly-added messages only (not label changes).
      if (delta.added && delta.added.length > 0) {
        await this.pushAddedMessages(account, delta.added)
      }
      // Dismiss phone notifications for threads that got archived (INBOX
      // removed) or deleted — covers both in-app actions (browser → hub →
      // Gmail) and external ones (stock Gmail app). One cancel per unique
      // threadId; the APK ignores unknown notifIds harmlessly.
      const handledThreads = new Set<string>()
      for (const lc of delta.labelChanged ?? []) {
        if (lc.threadId && lc.removedLabels?.includes('INBOX')) handledThreads.add(lc.threadId)
      }
      for (const r of delta.removed ?? []) {
        if (r.threadId) handledThreads.add(r.threadId)
      }
      for (const threadId of handledThreads) {
        this.push.broadcast({
          type: 'mail',
          cancel: true,
          account,
          threadId,
          id: `mail:${account}:${threadId}`,
        })
      }
    }
  }

  /**
   * Fetch metadata (From/Subject/snippet) for each newly-added message and
   * emit one push per thread. The most recent message in a thread wins —
   * subsequent messages in the same sync tick update the same notification
   * via the shared `id`.
   */
  private async pushAddedMessages(
    account: string,
    added: Array<{ threadId: string; messageId: string }>,
  ): Promise<void> {
    const byThread = new Map<string, string>()
    for (const a of added) byThread.set(a.threadId, a.messageId)

    for (const [threadId, messageId] of byThread) {
      try {
        const msg = await this.gmail.getMessage(messageId, {
          account,
          format: 'metadata',
        }) as { snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } }
        const headers = msg.payload?.headers ?? []
        const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? ''
        const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '(no subject)'
        const { name: fromName, email: fromEmail } = parseFrom(from)
        const snippet = msg.snippet ?? ''
        this.push.broadcast({
          type: 'mail',
          title: fromName || fromEmail || account,
          body: subject,
          pane: 'mail',
          id: `mail:${account}:${threadId}`,
          account,
          threadId,
          messageId,
          fromName,
          fromEmail,
          subject,
          snippet,
        })
      } catch (e) {
        this.log(`[mail-sync] push metadata failed for ${messageId}: ${(e as Error).message}`)
      }
    }
  }

  private loadState(): void {
    try {
      if (existsSync(this.stateFile)) {
        this.state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as MailState
      }
    } catch (e) {
      this.log(`[mail-sync] failed to load state: ${e}`)
      this.state = {}
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
    } catch (e) {
      this.log(`[mail-sync] failed to save state: ${e}`)
    }
  }
}
