// Baileys WhatsApp integration absorbed into Console hub.
//
// Critical posture: every Baileys/Atoms callback runs inside a try/catch at
// the boundary so a single unhandled exception cannot take the hub down.
// Reconnect is exponential-backoff with `setTimeout`, never `throw` — the hub
// hosts every other agent session (including the Al session that owns this
// integration) and an unhandled error here means total agent blackout.
//
// What's exposed:
//   - startWhatsApp(callbacks): begin / restart the Baileys socket
//   - isConnected(): current socket health
//   - sendText(to, text): outbound text → returns { id }
//   - deleteForEveryone(to, id): revoke message (2-day window upstream)
//   - getQrDataUrl(): the most recent QR (data URL string) — null when paired
//   - inboundEnvelope(): pure helper that formats an inbound message
//
// What it does NOT do:
//   - Decide who to send to (caller's job; OWNER_PHONE guard lives in the route)
//   - Render notifications elsewhere (caller injects callbacks)
//   - Auto-discover users (caller calls ensureUserKnown)

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadContentFromMessage,
  type DownloadableMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'
import { rm } from 'node:fs/promises'
import { AUTH_WHATSAPP_DIR } from './identity.js'

const logger = pino({ level: 'silent' })

export interface WhatsAppImage {
  data: string  // base64
  mimeType: string
}

export interface WhatsAppInbound {
  id: string
  jid: string                  // remoteJid
  sender: string               // group→participant, DM→jid (raw, pre-normalize)
  senderName?: string
  text: string
  images: WhatsAppImage[]
  timestamp: number
}

export interface WhatsAppCallbacks {
  /** Called for every inbound message that survived the fromMe filter. */
  onInbound: (msg: WhatsAppInbound) => void | Promise<void>
  /** Called when WA needs pairing — `dataUrl` is a fresh QR PNG. Wired to inject the QR into Al's session. */
  onQrUpdate: (dataUrl: string) => void
  /** Called on state-transition (connected, disconnected, logged-out). NOT per Baileys event — only on actual changes. */
  onHealthChange: (state: 'connected' | 'disconnected' | 'logged-out', detail?: string) => void
}

let sock: WASocket | null = null
let connected = false
let latestQrDataUrl: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let callbacks: WhatsAppCallbacks | null = null

export function isConnected(): boolean {
  return connected && !!sock?.user
}

export function getQrDataUrl(): string | null {
  // QR is invalidated once we pair.
  return connected ? null : latestQrDataUrl
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectAttempt++
  const delay = Math.min(3_000 * 2 ** Math.min(reconnectAttempt - 1, 5), 60_000)
  console.log(`[al/wa] reconnect in ${delay}ms (attempt ${reconnectAttempt})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startWhatsApp(callbacks!).catch((err) => {
      console.error('[al/wa] reconnect failed:', (err as Error)?.message)
      scheduleReconnect()
    })
  }, delay)
}

/**
 * Silence libsignal's noisy `console.info("Decrypted message with closed session")`
 * lines. Cosmetic but loud enough to drown out real log output.
 * Installed once on first startWhatsApp(); idempotent.
 */
let libsignalSilenced = false
function silenceLibsignal(): void {
  if (libsignalSilenced) return
  libsignalSilenced = true
  const origInfo = console.info
  console.info = (...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string' && /session/i.test(first)) return
    origInfo(...args)
  }
}

export async function startWhatsApp(cb: WhatsAppCallbacks): Promise<void> {
  callbacks = cb
  silenceLibsignal()

  // Close prior socket on reconnect
  if (sock) {
    try { sock.end(undefined) } catch { /* ignore */ }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_WHATSAPP_DIR)
  const { version } = await fetchLatestBaileysVersion()
  console.log(`[al/wa] using WA version: ${version.join('.')}`)

  sock = makeWASocket({
    auth: state,
    logger,
    version,
    browser: Browsers.ubuntu('Chrome'),
  })

  sock.ev.on('creds.update', () => {
    saveCreds().catch((err) => console.error('[al/wa] saveCreds failed:', (err as Error)?.message))
  })

  sock.ev.on('connection.update', (update) => {
    try {
      if (update.qr) {
        QRCode.toDataURL(update.qr, { width: 300 }, (err, dataUrl) => {
          if (err) {
            console.error('[al/wa] QR data URL render failed:', err.message)
            return
          }
          latestQrDataUrl = dataUrl
          try { cb.onQrUpdate(dataUrl) } catch (e) {
            console.error('[al/wa] onQrUpdate threw:', (e as Error)?.message)
          }
        })
      }

      if (update.connection === 'open') {
        const wasConnected = connected
        connected = true
        reconnectAttempt = 0
        latestQrDataUrl = null
        console.log('[al/wa] connected')
        if (!wasConnected) {
          try { cb.onHealthChange('connected') } catch (e) {
            console.error('[al/wa] onHealthChange threw:', (e as Error)?.message)
          }
        }
      }

      if (update.connection === 'close') {
        const wasConnected = connected
        connected = false
        const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode
        if (statusCode === DisconnectReason.loggedOut) {
          console.error('[al/wa] logged out — wiping auth and re-pairing')
          if (wasConnected) {
            try { cb.onHealthChange('logged-out', 'session invalidated by WhatsApp') } catch { /* ignore */ }
          }
          rm(AUTH_WHATSAPP_DIR, { recursive: true, force: true })
            .then(() => {
              console.log('[al/wa] auth wiped; restarting socket')
              return startWhatsApp(cb)
            })
            .catch((err) => {
              console.error('[al/wa] self-heal failed:', (err as Error)?.message)
              scheduleReconnect()
            })
        } else {
          if (wasConnected) {
            try { cb.onHealthChange('disconnected', `code=${statusCode ?? 'unknown'}`) } catch { /* ignore */ }
          }
          scheduleReconnect()
        }
      }
    } catch (err) {
      console.error('[al/wa] connection.update handler threw:', (err as Error)?.message)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        // Footgun #2: drop fromMe at the boundary, before any per-message work.
        // Without this, Yousef messaging Rowan from his phone feeds back into Al.
        if (!msg.message || msg.key.fromMe) continue

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          ''

        const images: WhatsAppImage[] = []
        const imgMsg = msg.message.imageMessage
        if (imgMsg) {
          try {
            const stream = await downloadContentFromMessage(imgMsg as DownloadableMessage, 'image')
            const chunks: Buffer[] = []
            for await (const chunk of stream) chunks.push(chunk)
            const buffer = Buffer.concat(chunks)
            images.push({ data: buffer.toString('base64'), mimeType: imgMsg.mimetype || 'image/jpeg' })
          } catch (err) {
            console.error('[al/wa] image download failed:', (err as Error)?.message)
          }
        }

        if (!text && images.length === 0) continue

        // Best-effort read receipt — don't fail the message if this throws.
        if (sock) {
          sock.readMessages([msg.key]).catch((err: Error) =>
            console.error('[al/wa] readMessages failed:', err.message),
          )
        }

        const jid = msg.key.remoteJid!
        const sender = msg.key.participant || jid

        await cb.onInbound({
          id: msg.key.id!,
          jid,
          sender,
          senderName: msg.pushName || undefined,
          text,
          images,
          timestamp: typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp * 1000 : Date.now(),
        })
      } catch (err) {
        console.error('[al/wa] messages.upsert per-message handler threw:', (err as Error)?.message)
      }
    }
  })
}

/** Outbound text. Caller passes a phone or JID; we suffix `@s.whatsapp.net` if bare. */
export async function sendText(to: string, text: string): Promise<{ id: string; jid: string }> {
  if (!sock || !connected) throw new Error('WhatsApp not connected')
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  const result = await sock.sendMessage(jid, { text })
  const id = result?.key?.id
  if (!id) throw new Error('send returned no message id')
  return { id, jid }
}

/**
 * Revoke for everyone. WhatsApp ignores delete requests past ~48 h; Baileys
 * does not surface a specific error for that — the request just doesn't take
 * effect. Caller should warn the user accordingly.
 */
export async function deleteForEveryone(to: string, messageId: string): Promise<void> {
  if (!sock || !connected) throw new Error('WhatsApp not connected')
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: messageId } })
}

/**
 * Compose an envelope to inject into Al's Console session as a user prompt.
 * Plain text with a recognisable header line; Al's prompt training will parse
 * it (sibling agents reading the messageLog do the same).
 */
export function inboundEnvelope(msg: WhatsAppInbound, resolvedUser: string | null): string {
  const user = resolvedUser ?? 'unknown'
  const senderTag = msg.senderName ? `${msg.senderName} (${msg.sender})` : msg.sender
  // Envelope is framed as a TASK with a required ACTION (Bash call), not as a
  // chat message awaiting a reply. This stops Claude from defaulting to a
  // conversational in-session reply (which fails silently — the WA sender
  // never sees your session text). The text you write in this session after
  // the Bash call is the OPERATOR LOG, not the reply.
  return [
    `[INBOUND WhatsApp — action required]`,
    `From: ${senderTag} — resolved user: ${user}`,
    `Thread: ${msg.jid}`,
    `Message ID: ${msg.id}`,
    ``,
    `Message:`,
    msg.text,
    ``,
    `---`,
    `ACTION (do this FIRST, before any explanation):`,
    `  Bash → con whatsapp send ${msg.jid} --body "<short conversational reply, plain text, no markdown, sound like a person texting>"`,
    `Then write ONE line in this session describing what you replied — operator log only, the WhatsApp sender does NOT see this session.`,
    ``,
    `If no reply is appropriate (informational only, told to stay silent on this thread, etc.):`,
    `  Skip the Bash call and write ONE line in this session explaining why.`,
    ``,
    `Critical: a text response in this session WITHOUT the Bash call fails silently — the WhatsApp sender hears NOTHING.`,
  ].join('\n')
}
