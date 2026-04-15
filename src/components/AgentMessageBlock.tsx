import { memo, useMemo, useState, useCallback, useRef } from 'react'
import type { AgentMessage } from '@/store/agent'
import { useAgentStore } from '@/store/agent'
import {
  ChevronRight, ChevronDown, Brain, Terminal, FileText, Search,
  Pencil, Globe, AlertTriangle, ClipboardList, ArrowRightLeft, Volume2, Square,
} from 'lucide-react'

// ============================================================================
// AgentMessageBlock — renders a single block in the agent message stream.
// Blocks: text, thinking, tool_use, tool_result, user_prompt, status, error, result
// ============================================================================

interface Props {
  message: AgentMessage
  toolResult?: AgentMessage
}

export const AgentMessageBlock = memo(function AgentMessageBlock({ message, toolResult }: Props) {
  const { block } = message

  switch (block.type) {
    case 'text':
      return <TextBlock content={block.content} />
    case 'thinking':
      return <ThinkingBlock message={message} content={block.content} collapsed={block.collapsed} />
    case 'tool_use': {
      const result = toolResult?.block.type === 'tool_result' ? toolResult.block : undefined
      if (block.toolName === 'EnterPlanMode') {
        return <ModeTransitionBlock label="Entered plan mode" />
      }
      if (block.toolName === 'ExitPlanMode') {
        return <PlanResultBlock plan={result?.content} />
      }
      return <ToolUseBlock toolName={block.toolName} input={block.input} result={result} />
    }
    case 'tool_result':
      return null // Rendered inside tool_use block
    case 'user_prompt':
      return <UserPromptBlock content={block.content} images={block.images} />
    case 'status':
      return null // Status shown in status bar, not in stream
    case 'error':
      return <ErrorBlock message={block.message} />
    case 'result':
      return null
    default:
      return null
  }
})

// --------------------------------------------------------------------------
// Text block — Claude's response text
// --------------------------------------------------------------------------

function TextBlock({ content }: { content: string }) {
  const rendered = useMemo(() => renderMarkdownLite(content), [content])
  const [speaking, setSpeaking] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)

  const toggleSpeak = useCallback(async () => {
    if (speaking) {
      speechSynthesis.cancel()
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
      setSpeaking(false)
      return
    }
    const plain = content
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#+\s+/gm, '')
    setSpeaking(true)

    // Try browser speechSynthesis first (works on mobile/macOS/Windows)
    if (speechSynthesis.getVoices().length > 0) {
      speechSynthesis.cancel()
      const chunks = plain.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [plain]
      let i = 0
      const speakNext = () => {
        if (i >= chunks.length) { setSpeaking(false); return }
        const u = new SpeechSynthesisUtterance(chunks[i]!.trim())
        u.onend = () => { i++; speakNext() }
        u.onerror = () => setSpeaking(false)
        speechSynthesis.speak(u)
      }
      setTimeout(speakNext, 50)
      return
    }

    // Fallback: hub-side espeak-ng (Linux without browser voices)
    try {
      const { getHubUrl } = await import('@/hub')
      const res = await fetch(`${getHubUrl()}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: plain }),
      })
      if (!res.ok) throw new Error('TTS failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url); audioRef.current = null }
      audio.onerror = () => { setSpeaking(false); URL.revokeObjectURL(url); audioRef.current = null }
      audio.play()
    } catch {
      setSpeaking(false)
    }
  }, [content, speaking])

  return (
    <div className="group relative px-3 py-1.5 hover:bg-surface-1 transition-colors duration-fast">
      <div className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed">
        {rendered}
      </div>
      {/* Hover action — floating, no extra vertical space */}
      <div className={`absolute -top-2 right-2 z-10 ${speaking ? 'flex' : 'hidden group-hover:flex'} items-center bg-surface-1 border border-border rounded-sm shadow-sm px-0.5 py-0.5`}>
        <button
          onClick={toggleSpeak}
          className={`p-1 cursor-pointer ${speaking ? 'text-warning' : 'text-text-tertiary hover:text-text-primary'}`}
          title={speaking ? 'Stop speaking' : 'Read aloud'}
        >
          {speaking ? <Square size={11} /> : <Volume2 size={11} />}
        </button>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Thinking block — collapsible extended thinking
// --------------------------------------------------------------------------

function ThinkingBlock({ message, content, collapsed }: { message: AgentMessage; content: string; collapsed: boolean }) {
  const toggle = useAgentStore((s) => s.toggleThinkingCollapsed)

  return (
    <div className="px-3 py-1">
      <button
        onClick={() => toggle(message.id)}
        className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <Brain size={11} />
        <span>Thinking</span>
        {collapsed && (
          <span className="text-text-tertiary ml-1">
            ({content.length > 100 ? `${Math.ceil(content.length / 100) * 100} chars` : `${content.length} chars`})
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="mt-1 ml-5 text-xs text-text-tertiary italic whitespace-pre-wrap break-words leading-relaxed max-h-60 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Tool use block — shows tool name and input
// --------------------------------------------------------------------------

function ToolUseBlock({ toolName, input, result }: {
  toolName: string
  input: Record<string, unknown>
  result?: { content: string; isError: boolean }
}) {
  const [expanded, setExpanded] = useState(false)
  const Icon = toolIcon(toolName)

  return (
    <div className="px-3 py-1 min-w-0 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-start gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast text-left max-w-full ${
          result?.isError ? 'text-destructive' : ''
        }`}
      >
        <span className="flex items-center gap-1.5 flex-shrink-0 mt-px">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Icon size={11} />
        </span>
        <span className="min-w-0 overflow-hidden">
          <span className="font-medium text-text-primary">{toolName}</span>{' '}
          <span className="text-text-tertiary"><ToolDetail toolName={toolName} input={input} /></span>
        </span>
      </button>
      {expanded && result && (
        <pre className={`mt-1 ml-5 p-2 rounded-sm text-[11px] font-mono whitespace-pre-wrap break-words overflow-x-auto max-h-60 overflow-y-auto ${
          result.isError ? 'border border-destructive/30 bg-destructive-muted/30 text-destructive' : 'bg-surface-1 border border-border text-text-secondary'
        }`}>
          {result.content}
        </pre>
      )}
    </div>
  )
}

/** Render tool args in a human-readable way, inline.
 *  Primary arg shown first, then remaining metadata as key=value pairs. */
function ToolDetail({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  // Primary arg key per tool — shown as the main value, rest as metadata
  const primaryKey = ({
    Read: 'file_path', Write: 'file_path', Edit: 'file_path',
    Bash: 'command', Glob: 'pattern', Grep: 'pattern',
    WebSearch: 'query', WebFetch: 'url', Agent: 'description',
  } as Record<string, string>)[toolName]

  // Keys to skip in metadata (not useful to display)
  const skipKeys = new Set(['old_string', 'new_string', 'content', 'data', 'prompt'])

  const primaryVal = primaryKey ? input[primaryKey] : undefined
  const rest = Object.entries(input).filter(([k, v]) =>
    k !== primaryKey && v !== undefined && v !== false && !skipKeys.has(k),
  )

  return (
    <span className="font-mono break-all">
      {primaryVal !== undefined && String(primaryVal)}
      {rest.length > 0 && (
        <span className="text-text-quaternary">
          {' '}{rest.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}
        </span>
      )}
    </span>
  )
}

// --------------------------------------------------------------------------
// Mode transition blocks
// --------------------------------------------------------------------------

function ModeTransitionBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 my-2">
      <div className="flex-1 border-t border-border" />
      <span className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
        <ArrowRightLeft size={10} />
        {label}
      </span>
      <div className="flex-1 border-t border-border" />
    </div>
  )
}

function PlanResultBlock({ plan }: { plan?: string }) {
  const [expanded, setExpanded] = useState(true)
  const rendered = useMemo(() => plan ? renderMarkdownLite(plan) : null, [plan])

  return (
    <div className="mx-3 my-2">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1 border-t border-border" />
        <span className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
          <ArrowRightLeft size={10} />
          Exited plan mode
        </span>
        <div className="flex-1 border-t border-border" />
      </div>
      {plan && (
        <div className="border border-border rounded-sm overflow-hidden">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-1 transition-colors duration-fast"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ClipboardList size={11} />
            <span>Plan</span>
          </button>
          {expanded && (
            <div className="px-3 py-2 text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed border-t border-border">
              {rendered}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// (ToolResultBlock removed — results are rendered inline within ToolUseBlock)

// --------------------------------------------------------------------------
// User prompt block
// --------------------------------------------------------------------------

function UserPromptBlock({ content, images }: { content: string; images?: string[] }) {
  return (
    <div className="px-3 py-2 bg-surface-1 border-y border-border">
      <div className="flex items-start gap-2">
        <span className="text-xs font-medium text-text-tertiary mt-0.5">You</span>
        <div className="min-w-0">
          {images && images.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-1.5">
              {images.map((src, i) => (
                <img key={i} src={src} alt={`Attached image ${i + 1}`} className="max-h-32 max-w-[200px] border border-border object-contain" />
              ))}
            </div>
          )}
          <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{content}</p>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Error block
// --------------------------------------------------------------------------

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="mx-3 my-1 flex items-start gap-1.5 rounded-sm border border-destructive/30 bg-destructive-muted/30 px-2 py-1.5">
      <AlertTriangle size={12} className="text-destructive mt-0.5 flex-shrink-0" />
      <p className="text-xs text-destructive break-words">{message}</p>
    </div>
  )
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function toolIcon(name: string) {
  switch (name) {
    case 'Read': return FileText
    case 'Write': return FileText
    case 'Edit': return Pencil
    case 'Bash': return Terminal
    case 'Glob': return Search
    case 'Grep': return Search
    case 'WebSearch': return Globe
    case 'WebFetch': return Globe
    default: return Terminal
  }
}

/** Lightweight markdown: code blocks, tables, inline code, bold, italic */
export function renderMarkdownLite(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let key = 0

  // Split on code fences first
  const fenceRegex = /```(\w*)\n?([\s\S]*?)```/g
  let lastIndex = 0

  for (const match of text.matchAll(fenceRegex)) {
    if (match.index > lastIndex) {
      parts.push(...renderBlockContent(text.slice(lastIndex, match.index), key))
      key += 100
    }
    const lang = match[1]
    const code = match[2]!.replace(/\n$/, '')
    parts.push(
      <pre key={key++} className="my-1 p-2 rounded-sm bg-surface-2 text-[11px] font-mono overflow-x-auto max-w-[calc(100vw-24px)]">
        {lang && <span className="text-[9px] text-text-tertiary uppercase tracking-wider">{lang}</span>}
        <code>{code}</code>
      </pre>,
    )
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(...renderBlockContent(text.slice(lastIndex), key))
  }

  return parts.length > 0 ? parts : [<span key={0}>{text}</span>]
}

/** Parse tables and inline markdown from non-code-fence text */
function renderBlockContent(text: string, startKey: number): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let key = startKey

  // Split into lines to detect tables
  const lines = text.split('\n')
  let i = 0

  while (i < lines.length) {
    // Detect table: line with |, followed by separator line (|---|---|), followed by more | lines
    if (
      lines[i]!.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*[-:]+[-| :]*$/.test(lines[i + 1]!)
    ) {
      // Collect all table lines
      const headerLine = lines[i]!
      i += 2 // skip header + separator
      const bodyLines: string[] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        bodyLines.push(lines[i]!)
        i++
      }

      const parseRow = (line: string) =>
        line.split('|').map((c) => c.trim()).filter((c, idx, arr) =>
          // Filter empty first/last from leading/trailing |
          !(c === '' && (idx === 0 || idx === arr.length - 1)),
        )

      const headers = parseRow(headerLine)
      const rows = bodyLines.map(parseRow)

      parts.push(
        <div key={key++} className="my-1 overflow-x-auto max-w-[calc(100vw-24px)]">
          <table className="text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                {headers.map((h, j) => (
                  <th key={j} className="px-2 py-1 text-left text-text-secondary font-medium whitespace-nowrap">
                    {renderInlineMarkdown(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-border/50">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-2 py-1 text-text-primary whitespace-nowrap">
                      {renderInlineMarkdown(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
    } else {
      // Non-table line — collect consecutive non-table lines
      const lineStart = i
      while (
        i < lines.length &&
        !(lines[i]!.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+[-| :]*$/.test(lines[i + 1]!))
      ) {
        i++
      }
      const chunk = lines.slice(lineStart, i).join('\n')
      if (chunk) {
        parts.push(<span key={key++}>{renderInlineMarkdown(chunk)}</span>)
      }
    }
  }

  return parts
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let key = 0

  // Handle inline code, bold, and italic in one pass
  // Order matters: code first (so **bold** inside backticks stays literal), then bold, then italic
  const inlineRegex = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*/g
  let lastIndex = 0

  for (const match of text.matchAll(inlineRegex)) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>)
    }
    if (match[1] !== undefined) {
      // Inline code
      parts.push(
        <code key={key++} className="bg-surface-2 px-1 py-0.5 rounded-sm text-[11px] font-mono break-all">
          {match[1]}
        </code>,
      )
    } else if (match[2] !== undefined) {
      // Bold
      parts.push(<strong key={key++} className="font-semibold">{match[2]}</strong>)
    } else if (match[3] !== undefined) {
      // Italic
      parts.push(<em key={key++}>{match[3]}</em>)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>)
  }

  return parts.length > 0 ? parts : [<span key={0}>{text}</span>]
}
