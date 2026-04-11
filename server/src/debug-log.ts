// Debug log file manager — NDJSON append with auto-rotation

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DebugEvent } from './debug-protocol.js'

const MAX_LINES = 5000
const KEEP_LINES = 3000
const ROTATE_CHECK_INTERVAL = 100

export class DebugLog {
  private lineCount = 0
  private appendsSinceCheck = 0

  constructor(private filePath: string) {
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

  append(event: DebugEvent): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + '\n')
      this.lineCount++
      this.appendsSinceCheck++
      if (this.appendsSinceCheck >= ROTATE_CHECK_INTERVAL) {
        this.appendsSinceCheck = 0
        this.maybeRotate()
      }
    } catch {
      // Best effort — don't crash on log write failure
    }
  }

  appendBatch(events: DebugEvent[]): void {
    if (events.length === 0) return
    try {
      const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
      appendFileSync(this.filePath, lines)
      this.lineCount += events.length
      this.appendsSinceCheck += events.length
      if (this.appendsSinceCheck >= ROTATE_CHECK_INTERVAL) {
        this.appendsSinceCheck = 0
        this.maybeRotate()
      }
    } catch {
      // Best effort
    }
  }

  readTail(n: number): string[] {
    if (!existsSync(this.filePath)) return []
    try {
      const content = readFileSync(this.filePath, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      return lines.slice(-n)
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
