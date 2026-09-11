// Claude Code JSONL transcript → turns + tool events. The only file that knows
// the record shapes (they change between CLI releases).

import { readFileSync } from 'node:fs'
import { isSensitivePath, redact, SENSITIVE_PLACEHOLDER } from './redact.js'

export const RESULT_CAP = 8000
export const LONG_RESULT_CAP = 20000
const LONG_RESULT_TOOLS = new Set(['WebFetch', 'WebSearch', 'Agent'])
const INPUT_CAP = 1500
const ASSISTANT_CAP = 40000
const USER_CAP = 40000
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read'])

export interface ToolEvent {
  seq: number
  name: string
  inputSummary: string
  result: string
  truncated: boolean
}

export interface Turn {
  idx: number
  uuid: string
  ts: string
  userText: string
  assistantText: string
  events: ToolEvent[]
  /** path → set of 'read' | 'write' */
  files: Map<string, Set<'read' | 'write'>>
}

export interface ParsedSession {
  id: string
  cwd: string
  gitBranch: string
  title: string
  startedAt: string
  endedAt: string
  entrypoint: string
  turns: Turn[]
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (t) parts.push(t)
    }
  }
  return parts.join('\n')
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
const TAG_START = /^<[a-zA-Z][\w-]*[\s>/]/

/** Human prompt text, or '' for machine records (tool results, local-command
 *  echoes, reminders). Slash commands become `/name args`. */
export function humanText(record: Record<string, unknown>): string {
  const message = record.message as { content?: unknown } | undefined
  const raw = blocksText(message?.content).replace(SYSTEM_REMINDER, '').trim()
  if (!raw) return ''
  if (raw.startsWith('<command-name>') || raw.startsWith('<command-message>')) {
    const name = COMMAND_NAME.exec(raw)?.[1]?.trim() ?? ''
    const args = COMMAND_ARGS.exec(raw)?.[1]?.trim() ?? ''
    return name ? `${name}${args ? ' ' + args : ''}` : ''
  }
  if (TAG_START.test(raw)) return ''
  return raw
}

function toolPath(input: Record<string, unknown>): string {
  for (const k of ['file_path', 'notebook_path']) {
    const v = input[k]
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function inputSummary(input: Record<string, unknown>): string {
  const path = toolPath(input)
  if (path) return path
  for (const k of ['command', 'pattern', 'query', 'url', 'prompt', 'description']) {
    const v = input[k]
    if (typeof v === 'string' && v) return v.slice(0, INPUT_CAP)
  }
  try { return JSON.stringify(input).slice(0, INPUT_CAP) } catch { return '' }
}

function resultText(record: Record<string, unknown>, cap: number): [string, boolean] {
  const message = record.message as { content?: unknown } | undefined
  const content = message?.content
  let text = ''
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (!b || typeof b !== 'object' || (b as { type?: string }).type !== 'tool_result') continue
      const c = (b as { content?: unknown }).content
      if (typeof c === 'string') parts.push(c)
      else if (Array.isArray(c)) for (const x of c) if (x && typeof x === 'object' && typeof (x as { text?: string }).text === 'string') parts.push((x as { text: string }).text)
    }
    text = parts.join('\n')
  } else if (typeof content === 'string') {
    text = content
  }
  if (text.length > cap) return [text.slice(0, cap) + `\n[output truncated at ${cap} chars]`, true]
  return [text, false]
}

function toolResultUseId(record: Record<string, unknown>): string {
  const message = record.message as { content?: unknown } | undefined
  if (!Array.isArray(message?.content)) return ''
  for (const b of message!.content as Array<Record<string, unknown>>) {
    if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') return b.tool_use_id
  }
  return ''
}

class TranscriptParser {
  readonly session: ParsedSession
  private current: Turn | null = null
  private pending = new Map<string, ToolEvent>()
  private sensitive = new Set<string>()

  constructor(id: string) {
    this.session = { id, cwd: '', gitBranch: '', title: '', startedAt: '', endedAt: '', entrypoint: '', turns: [] }
  }

  feed(rec: Record<string, unknown>): void {
    const kind = rec.type
    if (kind === 'custom-title') { const t = rec.customTitle; if (typeof t === 'string' && t) this.session.title = redact(t); return }
    if (kind === 'ai-title') { const t = rec.aiTitle; if (typeof t === 'string' && t && !this.session.title) this.session.title = redact(t); return }
    if (rec.isSidechain) return
    this.noteMetadata(rec)
    if (kind === 'user') this.onUser(rec)
    else if (kind === 'assistant') this.onAssistant(rec)
  }

  private noteMetadata(rec: Record<string, unknown>): void {
    const ts = rec.timestamp
    if (typeof ts === 'string' && ts) {
      if (!this.session.startedAt) this.session.startedAt = ts
      this.session.endedAt = ts
    }
    if (typeof rec.cwd === 'string' && rec.cwd) this.session.cwd = rec.cwd
    if (typeof rec.gitBranch === 'string' && rec.gitBranch && rec.gitBranch !== 'HEAD') this.session.gitBranch = rec.gitBranch
    if (typeof rec.entrypoint === 'string' && rec.entrypoint) this.session.entrypoint = rec.entrypoint
  }

  private onUser(rec: Record<string, unknown>): void {
    if (rec.toolUseResult !== undefined || toolResultUseId(rec)) {
      const useId = toolResultUseId(rec)
      const event = this.pending.get(useId)
      if (!event) return
      this.pending.delete(useId)
      if (this.sensitive.has(useId)) event.result = SENSITIVE_PLACEHOLDER
      else {
        const [text, truncated] = resultText(rec, LONG_RESULT_TOOLS.has(event.name) ? LONG_RESULT_CAP : RESULT_CAP)
        event.result = redact(text)
        event.truncated = truncated
      }
      return
    }
    if (rec.isMeta || rec.isCompactSummary || rec.isVisibleInTranscriptOnly) return
    const text = humanText(rec)
    if (!text) return
    const turn: Turn = {
      idx: this.session.turns.length,
      uuid: typeof rec.uuid === 'string' ? rec.uuid : '',
      ts: typeof rec.timestamp === 'string' ? rec.timestamp : '',
      userText: redact(text.slice(0, USER_CAP)),
      assistantText: '',
      events: [],
      files: new Map(),
    }
    this.session.turns.push(turn)
    this.current = turn
  }

  private onAssistant(rec: Record<string, unknown>): void {
    const turn = this.current
    if (!turn) return
    const message = rec.message as { content?: unknown } | undefined
    const content = message?.content
    if (!Array.isArray(content)) return
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (turn.assistantText.length < ASSISTANT_CAP) {
          turn.assistantText = (turn.assistantText ? turn.assistantText + '\n\n' : '') + redact(block.text).slice(0, ASSISTANT_CAP - turn.assistantText.length)
        }
      } else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool'
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>
        const event: ToolEvent = { seq: turn.events.length, name, inputSummary: redact(inputSummary(input)), result: '', truncated: false }
        turn.events.push(event)
        const id = typeof block.id === 'string' ? block.id : ''
        if (id) this.pending.set(id, event)
        const path = toolPath(input)
        if (path) {
          if (isSensitivePath(path) && id) this.sensitive.add(id)
          const action = WRITE_TOOLS.has(name) ? 'write' : READ_TOOLS.has(name) ? 'read' : null
          if (action) {
            const set = turn.files.get(path) ?? new Set()
            set.add(action)
            turn.files.set(path, set)
          }
        }
      }
    }
  }
}

export function parseTranscriptText(text: string, sessionId: string): ParsedSession {
  const parser = new TranscriptParser(sessionId)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec: unknown
    try { rec = JSON.parse(line) } catch { continue }
    if (rec && typeof rec === 'object') parser.feed(rec as Record<string, unknown>)
  }
  return parser.session
}

export function parseTranscript(path: string, sessionId: string): ParsedSession {
  return parseTranscriptText(readFileSync(path, 'utf-8'), sessionId)
}

/** First prompt that a human (not the hub) typed — envelopes open with `[`. */
export function firstHumanPrompt(s: ParsedSession): string {
  const human = s.turns.find((t) => !t.userText.startsWith('[') && !t.userText.startsWith('/'))
  return (human ?? s.turns[0])?.userText ?? ''
}

export function lastHumanPrompt(s: ParsedSession): string {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const t = s.turns[i]!.userText
    if (!t.startsWith('[') && !t.startsWith('/')) return t
  }
  return ''
}

export function lastReply(s: ParsedSession): string {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const t = s.turns[i]!.assistantText
    if (t) return t
  }
  return ''
}
