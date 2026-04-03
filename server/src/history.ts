// JSONL session history loader — reads Claude's session files for replay

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { statSync, readdirSync } from 'node:fs'
import { cwdToProjectDir } from './utils.js'
import type { ClaudeContentBlock, PastSession } from './protocol.js'

export interface HistoryMessage {
  type: 'user_prompt' | 'text' | 'thinking' | 'tool_use' | 'tool_result'
  content?: string
  toolUseId?: string
  toolName?: string
  input?: Record<string, unknown>
  isError?: boolean
  images?: string[]
}

/**
 * Read a Claude JSONL session file and extract the conversation history
 * as simplified message blocks for the frontend.
 */
export function loadSessionHistory(claudeSessionId: string, cwdPath: string): HistoryMessage[] {
  const encoded = cwdToProjectDir(cwdPath)
  const filePath = join(homedir(), '.claude', 'projects', encoded, `${claudeSessionId}.jsonl`)
  if (!existsSync(filePath)) return []

  const messages: HistoryMessage[] = []
  const lines = readFileSync(filePath, 'utf-8').split('\n')

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.isSidechain) continue

      if (obj.type === 'user' && !obj.isMeta) {
        const content = obj.message?.content
        if (typeof content === 'string' && !content.startsWith('<')) {
          messages.push({ type: 'user_prompt', content })
        } else if (Array.isArray(content)) {
          const hasToolResult = content.some((b: ClaudeContentBlock) => b.type === 'tool_result')
          if (hasToolResult) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const resultContent = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: { text: string }) => c.text).join('\n')
                    : String(block.content)
                messages.push({
                  type: 'tool_result',
                  toolUseId: block.tool_use_id,
                  content: resultContent,
                  isError: block.is_error ?? false,
                })
              }
            }
          } else {
            const textBlock = content.find((b: { type: string }) => b.type === 'text')
            if (textBlock?.text && !textBlock.text.startsWith('<')) {
              messages.push({ type: 'user_prompt', content: textBlock.text })
            }
          }
        }
      } else if (obj.type === 'assistant') {
        const content = obj.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              messages.push({ type: 'text', content: block.text })
            } else if (block.type === 'thinking' && block.thinking) {
              messages.push({ type: 'thinking', content: block.thinking })
            } else if (block.type === 'tool_use') {
              messages.push({
                type: 'tool_use',
                toolUseId: block.id,
                toolName: block.name,
                input: block.input,
              })
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages
}

/**
 * List past Claude sessions for a given working directory.
 */
export async function listPastSessions(cwdPath: string): Promise<PastSession[]> {
  const encoded = cwdToProjectDir(cwdPath)
  const projectDir = join(homedir(), '.claude', 'projects', encoded)

  if (!existsSync(projectDir)) return []

  const entries = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
  const sessions: PastSession[] = []

  for (const file of entries) {
    const sessionId = basename(file, '.jsonl')
    const filePath = join(projectDir, file)

    try {
      const stat = statSync(filePath)
      const prompt = await extractFirstPrompt(filePath)
      if (prompt) {
        sessions.push({ sessionId, prompt, date: stat.mtimeMs })
      }
    } catch {
      // Skip unreadable files
    }
  }

  sessions.sort((a, b) => b.date - a.date)
  return sessions.slice(0, 20)
}

/**
 * Extract the first user prompt from a Claude JSONL session file.
 */
function extractFirstPrompt(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })

    let found = false

    rl.on('line', (line) => {
      if (found) return
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && obj.message?.role === 'user') {
          const content = obj.message.content
          let text: string | undefined
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: { type: string }) => b.type === 'text')
            text = textBlock?.text
          }
          if (text && !text.startsWith('<')) {
            found = true
            rl.close()
            resolve(text.slice(0, 200))
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    })

    rl.on('close', () => { if (!found) resolve(null) })
    rl.on('error', () => { if (!found) resolve(null) })
  })
}
