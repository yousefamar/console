// Research log for G1 reverse engineering.
//
// The APK forwards every interesting inbound BLE frame (except audio, which
// would drown the log, and heartbeat unless verbose mode is on) as a
// `glasses_frame` WS message. We append those to an NDJSON file so the user
// can correlate on-device actions (button presses, menu navigation in the
// EvenDemoApp running alongside) with opcode traffic.
//
// Entries are flat objects: { arm, hex, kind, ts, unknown? }. The `kind`
// comes straight from `BleManager.onFrame` classification. We tag
// `unknown: true` on anything classified as "unhandled" for easy filtering.
//
// Storage: `~/.config/console/glasses-research.log`, NDJSON, rotated at
// 5K lines (keep latest 3K), mirrors the debug-log pattern.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_LINES = 5000
const KEEP_LINES = 3000
const ROTATE_CHECK_INTERVAL = 100

export interface ResearchFrame {
  /** `'left'` | `'right'` for BLE frames; `'scan'` for scan observations. */
  arm: string
  kind: string
  hex: string
  ts: number
  /** Set when `kind === 'unhandled'` — lets `jq` / CLI filter trivially. */
  unknown?: true
  /** Populated for `kind === 'scan_observation'` — advertised device name. */
  name?: string
  /** Populated for scan observations — MAC of the advertising device. */
  mac?: string
  /** Populated for scan observations — RSSI in dBm. */
  rssi?: number
}

export class GlassesResearchLog {
  private lineCount = 0
  private appendsSinceCheck = 0

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf8')
        this.lineCount = content.split('\n').filter(Boolean).length
      } catch {
        this.lineCount = 0
      }
    }
  }

  append(frame: ResearchFrame): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(frame) + '\n')
      this.lineCount++
      this.appendsSinceCheck++
      if (this.appendsSinceCheck >= ROTATE_CHECK_INTERVAL) {
        this.appendsSinceCheck = 0
        this.maybeRotate()
      }
    } catch {
      // Best effort — research log is diagnostic, not critical.
    }
  }

  /** Last N entries as parsed objects. Bad lines are silently skipped. */
  tail(n: number): ResearchFrame[] {
    if (!existsSync(this.filePath)) return []
    try {
      const content = readFileSync(this.filePath, 'utf8')
      const lines = content.split('\n').filter(Boolean).slice(-n)
      const out: ResearchFrame[] = []
      for (const line of lines) {
        try { out.push(JSON.parse(line) as ResearchFrame) } catch { /* ignore */ }
      }
      return out
    } catch {
      return []
    }
  }

  getLineCount(): number {
    return this.lineCount
  }

  private maybeRotate(): void {
    if (this.lineCount <= MAX_LINES) return
    try {
      const content = readFileSync(this.filePath, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      const kept = lines.slice(-KEEP_LINES)
      writeFileSync(this.filePath, kept.join('\n') + '\n')
      this.lineCount = kept.length
    } catch {
      // Best effort
    }
  }
}
