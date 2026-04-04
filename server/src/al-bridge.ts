// Al Bridge — manages WebSocket connection between Al and Console hub
//
// Al connects as a WebSocket client. The bridge translates between
// Al's protocol and the existing HubMessage format that the browser renders.
// Al appears as a virtual session with fixed ID 'al'.

import { WebSocket } from 'ws'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { HubMessage, LoggableHubMessage, SessionInfo, TokenUsage } from './protocol.js'

export const AL_SESSION_ID = 'al'

// --------------------------------------------------------------------------
// Al → Hub protocol
// --------------------------------------------------------------------------

export type AlToHubMessage =
  | { type: 'al_register' }
  | { type: 'al_text'; text: string }
  | { type: 'al_text_delta'; text: string }
  | { type: 'al_tool_start'; id: string; command: string }
  | { type: 'al_tool_end'; id: string; output: string; exitCode: number }
  | { type: 'al_status'; text: string }
  | { type: 'al_idle' }

// --------------------------------------------------------------------------
// Hub → Al protocol
// --------------------------------------------------------------------------

export type HubToAlMessage =
  | { type: 'al_message'; text: string; images?: Array<{ media_type: string; data: string }> }
  | { type: 'al_clear' }
  | { type: 'al_interrupt' }

// --------------------------------------------------------------------------
// Bridge
// --------------------------------------------------------------------------

const LOG_DIR = join(homedir(), '.config', 'console')
const LOG_FILE = join(LOG_DIR, 'al-messages.json')
const MAX_MESSAGES = 500

export class AlBridge {
  private alWs: WebSocket | null = null
  private messageLog: HubMessage[] = []
  private broadcastFn: (msg: HubMessage) => void
  private logFn: (msg: string) => void
  private status: 'idle' | 'running' = 'idle'
  private connectedAt = 0
  private pendingText = '' // accumulates text_delta for logging on idle
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  private broadcastExceptFn: (sender: WebSocket, msg: HubMessage) => void

  constructor(opts: {
    broadcast: (msg: HubMessage) => void
    broadcastExcept: (sender: WebSocket, msg: HubMessage) => void
    log: (msg: string) => void
  }) {
    this.broadcastFn = opts.broadcast
    this.broadcastExceptFn = opts.broadcastExcept
    this.logFn = opts.log
    this.loadFromDisk()
  }

  // --------------------------------------------------------------------------
  // Al connection management
  // --------------------------------------------------------------------------

  handleAlConnection(ws: WebSocket): void {
    // If already connected, close old connection
    if (this.alWs && this.alWs.readyState === WebSocket.OPEN) {
      this.logFn('[al] replacing existing connection')
      this.alWs.close()
    }

    this.alWs = ws
    this.connectedAt = Date.now()
    this.status = 'idle'
    this.pendingText = ''
    this.logFn('[al] connected')

    // Broadcast updated session list (Al now shows as connected)
    this.broadcastSessionUpdate()

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as AlToHubMessage
        this.handleAlMessage(msg)
      } catch {
        this.logFn('[al] invalid message from Al')
      }
    })

    ws.on('close', () => {
      this.logFn('[al] disconnected')
      this.alWs = null
      this.status = 'idle'
      // Broadcast that Al is now disconnected
      this.broadcastFn({ type: 'session_ended', sessionId: AL_SESSION_ID })
    })

    ws.on('error', (err) => {
      this.logFn(`[al] WebSocket error: ${err.message}`)
    })
  }

  // --------------------------------------------------------------------------
  // Handle messages FROM Al
  // --------------------------------------------------------------------------

  private handleAlMessage(msg: AlToHubMessage): void {
    switch (msg.type) {
      case 'al_register':
        // Already handled in handleAlConnection
        break

      case 'al_text_delta': {
        const hubMsg: HubMessage = { type: 'text_delta', sessionId: AL_SESSION_ID, content: msg.text }
        this.broadcastFn(hubMsg)
        this.pendingText += msg.text // accumulate for logging on idle
        break
      }

      case 'al_text': {
        const hubMsg: HubMessage = { type: 'text', sessionId: AL_SESSION_ID, content: msg.text }
        this.broadcastFn(hubMsg)
        this.logMessage(hubMsg)
        break
      }

      case 'al_tool_start': {
        this.status = 'running'
        // Flush accumulated text before tool use (for message log)
        this.flushPendingText()
        const hubMsg: HubMessage = {
          type: 'tool_use',
          sessionId: AL_SESSION_ID,
          toolUseId: msg.id,
          toolName: 'exec',
          input: { command: msg.command },
        }
        this.broadcastFn(hubMsg)
        this.logMessage(hubMsg)

        // Also send status
        this.broadcastFn({ type: 'status', sessionId: AL_SESSION_ID, text: `Running: ${msg.command}` })
        break
      }

      case 'al_tool_end': {
        const hubMsg: HubMessage = {
          type: 'tool_result',
          sessionId: AL_SESSION_ID,
          toolUseId: msg.id,
          content: msg.output,
          isError: msg.exitCode !== 0,
        }
        this.broadcastFn(hubMsg)
        this.logMessage(hubMsg)
        break
      }

      case 'al_status': {
        this.status = 'running'
        this.broadcastFn({ type: 'status', sessionId: AL_SESSION_ID, text: msg.text })
        break
      }

      case 'al_idle': {
        this.flushPendingText()
        this.status = 'idle'
        // Clear the "Thinking..." status text
        this.broadcastFn({ type: 'status', sessionId: AL_SESSION_ID, text: '' })
        this.broadcastSessionUpdate()
        break
      }
    }
  }

  // --------------------------------------------------------------------------
  // Handle messages FROM browser (for session 'al')
  // --------------------------------------------------------------------------

  handleBrowserMessage(type: string, senderWs: WebSocket, content?: string, images?: Array<{ media_type: string; data: string }>): void {
    if (!this.alWs || this.alWs.readyState !== WebSocket.OPEN) {
      this.logFn('[al] cannot send — Al not connected')
      return
    }

    switch (type) {
      case 'send_message': {
        this.status = 'running'
        this.broadcastSessionUpdate()

        // Log the user prompt — broadcast to other clients only (sender already shows it locally)
        const userMsg: HubMessage = {
          type: 'user_prompt',
          sessionId: AL_SESSION_ID,
          content: content || '',
          ...(images?.length ? { images: images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}),
        }
        this.broadcastExceptFn(senderWs, userMsg)
        this.logMessage(userMsg)

        // Forward to Al
        const alMsg: HubToAlMessage = {
          type: 'al_message',
          text: content || '',
          images,
        }
        this.alWs.send(JSON.stringify(alMsg))
        break
      }

      case 'interrupt': {
        const alMsg: HubToAlMessage = { type: 'al_interrupt' }
        this.alWs.send(JSON.stringify(alMsg))
        break
      }

      case 'clear': {
        this.messageLog = []
        this.saveToDisk()
        const alMsg: HubToAlMessage = { type: 'al_clear' }
        this.alWs.send(JSON.stringify(alMsg))
        break
      }
    }
  }

  // --------------------------------------------------------------------------
  // Session info
  // --------------------------------------------------------------------------

  getSessionInfo(): SessionInfo {
    return {
      id: AL_SESSION_ID,
      status: this.alWs ? this.status : 'ended',
      createdAt: this.connectedAt || Date.now(),
      prompt: 'Al',
      cwd: undefined,
      totalCost: 0,
      totalTokens: { input: 0, output: 0 },
    }
  }

  isConnected(): boolean {
    return this.alWs !== null && this.alWs.readyState === WebSocket.OPEN
  }

  getMessageLog(): HubMessage[] {
    return this.messageLog
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private flushPendingText(): void {
    if (this.pendingText.trim()) {
      // Broadcast the coalesced text — the frontend needs this to convert
      // accumulated text_deltas into a proper message block
      const hubMsg: HubMessage = { type: 'text', sessionId: AL_SESSION_ID, content: this.pendingText }
      this.broadcastFn(hubMsg)
      this.logMessage(hubMsg)
    }
    this.pendingText = ''
  }

  private logMessage(msg: HubMessage): void {
    this.messageLog.push(msg)
    if (this.messageLog.length > MAX_MESSAGES) {
      this.messageLog = this.messageLog.slice(-MAX_MESSAGES)
    }
    this.schedulePersist()
  }

  // Debounced disk persistence (don't write on every message)
  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.saveToDisk()
    }, 2000)
  }

  private saveToDisk(): void {
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      writeFileSync(LOG_FILE, JSON.stringify(this.messageLog), 'utf8')
    } catch (err) {
      this.logFn(`[al] failed to persist message log: ${(err as Error).message}`)
    }
  }

  private loadFromDisk(): void {
    try {
      const data = readFileSync(LOG_FILE, 'utf8')
      this.messageLog = JSON.parse(data) as HubMessage[]
      this.logFn(`[al] loaded ${this.messageLog.length} messages from disk`)
    } catch {
      // First run or corrupt file
    }
  }

  private broadcastSessionUpdate(): void {
    // Broadcast a sessions_list update so the frontend picks up the status change.
    // We pass our own session info; the caller in index.ts will merge with agent sessions.
    if (this.onSessionUpdate) this.onSessionUpdate()
  }

  /** Set by index.ts to trigger a full sessions_list broadcast */
  onSessionUpdate: (() => void) | null = null
}
