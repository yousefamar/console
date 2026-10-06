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

/** What a transcript knows about itself: the cwd its turns ran in, and the
 *  session's recorded agent name. Found by locating `<csid>.jsonl` under
 *  ~/.claude/projects/ — the directory name encodes the cwd lossily (slashes
 *  become dashes), so the cwd is read from a message line instead of decoded.
 *  Lets a resume recover its identity with no manifest row to inherit from. */
export function findTranscriptIdentity(claudeSessionId: string): { cwd?: string; name?: string } | null {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return null
  let filePath: string | undefined
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${claudeSessionId}.jsonl`)
    if (existsSync(candidate)) { filePath = candidate; break }
  }
  if (!filePath) return null
  const out: { cwd?: string; name?: string } = {}
  try {
    // The cwd appears on the first real message line, well inside the head.
    for (const line of readFileSync(filePath, 'utf-8').split('\n', 50)) {
      if (!line.trim()) continue
      const obj = JSON.parse(line) as { cwd?: string; agentName?: string }
      if (!out.name && typeof obj.agentName === 'string' && obj.agentName) out.name = obj.agentName
      if (typeof obj.cwd === 'string' && obj.cwd) { out.cwd = obj.cwd; break }
    }
  } catch { /* a truncated or non-JSON head just yields less */ }
  return out.cwd || out.name ? out : null
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
