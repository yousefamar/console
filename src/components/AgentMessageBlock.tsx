import { memo, useEffect, useMemo, useState, useCallback, useRef } from 'react'
import type { AgentMessage, DiffHunk } from '@/store/agent'
import { useAgentStore } from '@/store/agent'
import {
  ChevronRight, ChevronDown, Brain, Terminal, FileText, Search,
  Pencil, Globe, AlertTriangle, ClipboardList, ArrowRightLeft, Volume2, Square,
  Check, Circle, Loader2, ListTodo, Copy,
} from 'lucide-react'

// ============================================================================
// AgentMessageBlock — renders a single block in the agent message stream.
// Blocks: text, thinking, tool_use, tool_result, user_prompt, status, error, result
// ============================================================================

interface Props {
  message: AgentMessage
  toolResult?: AgentMessage
  toolDiff?: AgentMessage
}

export const AgentMessageBlock = memo(function AgentMessageBlock({ message, toolResult, toolDiff }: Props) {
  const { block } = message

  switch (block.type) {
    case 'text':
      return <TextBlock content={block.content} />
    case 'thinking':
      return <ThinkingBlock message={message} content={block.content} collapsed={block.collapsed} />
    case 'tool_use': {
      const result = toolResult?.block.type === 'tool_result' ? toolResult.block : undefined
      const diff = toolDiff?.block.type === 'tool_diff' ? toolDiff.block : undefined
      if (block.toolName === 'EnterPlanMode') {
        return <ModeTransitionBlock label="Entered plan mode" />
      }
      if (block.toolName === 'ExitPlanMode') {
        return <PlanResultBlock plan={result?.content} />
      }
      if (block.toolName === 'TodoWrite') {
        return <TodoListBlock input={block.input} />
      }
      return <ToolUseBlock toolName={block.toolName} input={block.input} result={result} diff={diff} />
    }
    case 'tool_result':
    case 'tool_diff':
      return null // Rendered inside tool_use block
    case 'bg_task':
      return <BgTaskBlock block={block} />
    case 'user_prompt':
      return <UserPromptBlock content={block.content} images={block.images} />
    case 'status':
      return null // Status shown in status bar, not in stream
    case 'error':
      return <ErrorBlock message={block.message} />
    case 'result':
      return <ResultFooterBlock block={block} />
    default:
      return null
  }
})

// --------------------------------------------------------------------------
// Text block — Claude's response text
// --------------------------------------------------------------------------

function TextBlock({ content }: { content: string }) {
  // Hide the `@handoff(<key>)` control sentinel from display — it drives the
  // "Talk to X" banner (see store `session_handoff`), it's not message text.
  const rendered = useMemo(() => renderMarkdownLite(content.replace(/\B@handoff\([a-z0-9-]+\)/gi, '').replace(/[ \t]{2,}/g, ' ').trimEnd()), [content])
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

function ToolUseBlock({ toolName, input, result, diff }: {
  toolName: string
  input: Record<string, unknown>
  result?: { content: string; isError: boolean }
  diff?: { filePath: string; hunks: DiffHunk[] }
}) {
  const [expanded, setExpanded] = useState(false)
  const Icon = toolIcon(toolName)

  return (
    <div className="px-3 py-1 min-w-0 overflow-hidden w-full">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-start gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors duration-fast text-left w-full min-w-0 ${
          result?.isError ? 'text-destructive' : ''
        }`}
      >
        <span className="flex items-center gap-1.5 flex-shrink-0 mt-px">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Icon size={11} />
        </span>
        <span className="flex-1 min-w-0 [overflow-wrap:anywhere] [word-break:break-word]">
          <span className="font-medium text-text-primary">{toolName}</span>{' '}
          <span className="text-text-tertiary"><ToolDetail toolName={toolName} input={input} /></span>
          {diff && <DiffStat hunks={diff.hunks} />}
        </span>
      </button>
      {/* Edits/Writes render their diff inline by default — the terminal experience */}
      {diff && <DiffBlock hunks={diff.hunks} />}
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

// --------------------------------------------------------------------------
// Diff rendering — the CLI's structuredPatch (jsdiff hunks) rendered
// terminal-style: red/green lines, gutter line numbers, hunk separators.
// --------------------------------------------------------------------------

function DiffStat({ hunks }: { hunks: DiffHunk[] }) {
  let added = 0, removed = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  }
  return (
    <span className="ml-1.5 font-mono text-[10px]">
      {added > 0 && <span className="text-green-500">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-red-500">-{removed}</span>}
    </span>
  )
}

function DiffBlock({ hunks }: { hunks: DiffHunk[] }) {
  // Cap what we render eagerly — a full-file Write can be thousands of lines.
  const MAX_LINES = 80
  const [showAll, setShowAll] = useState(false)
  const totalLines = hunks.reduce((n, h) => n + h.lines.length, 0)

  let budget = showAll ? Infinity : MAX_LINES
  const rows: Array<{ key: string; kind: 'add' | 'del' | 'ctx' | 'sep'; oldNo?: number; newNo?: number; text: string }> = []
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi]!
    if (hi > 0) rows.push({ key: `sep${hi}`, kind: 'sep', text: '···' })
    let oldNo = h.oldStart
    let newNo = h.newStart
    for (let li = 0; li < h.lines.length; li++) {
      if (budget-- <= 0) break
      const l = h.lines[li]!
      const kind = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'
      rows.push({
        key: `${hi}:${li}`,
        kind,
        oldNo: kind === 'add' ? undefined : oldNo,
        newNo: kind === 'del' ? undefined : newNo,
        text: l.slice(1),
      })
      if (kind !== 'add') oldNo++
      if (kind !== 'del') newNo++
    }
    if (budget <= 0) break
  }

  return (
    <div className="mt-1 ml-5 rounded-sm border border-border bg-surface-1 overflow-hidden">
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="w-full border-collapse font-mono text-[11px] leading-[1.5]">
          <tbody>
            {rows.map((r) => r.kind === 'sep' ? (
              <tr key={r.key}>
                <td colSpan={3} className="px-2 text-text-quaternary text-center select-none bg-surface-2/50">{r.text}</td>
              </tr>
            ) : (
              <tr key={r.key} className={
                r.kind === 'add' ? 'bg-green-500/10' : r.kind === 'del' ? 'bg-red-500/10' : ''
              }>
                <td className="px-1.5 text-right text-text-quaternary select-none w-8 align-top">{r.newNo ?? r.oldNo ?? ''}</td>
                <td className={`w-4 text-center select-none align-top ${
                  r.kind === 'add' ? 'text-green-500' : r.kind === 'del' ? 'text-red-500' : 'text-transparent'
                }`}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</td>
                <td className={`pr-2 whitespace-pre-wrap break-words align-top ${
                  r.kind === 'add' ? 'text-green-300' : r.kind === 'del' ? 'text-red-300/80' : 'text-text-secondary'
                }`}>{r.text || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!showAll && totalLines > MAX_LINES && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full px-2 py-1 text-[10px] text-text-tertiary hover:text-text-primary bg-surface-2/50 transition-colors duration-fast"
        >
          Show all {totalLines} lines
        </button>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Background task chip — bash-in-background / Task subagent lifecycle.
// --------------------------------------------------------------------------

function BgTaskBlock({ block }: { block: { taskId: string; status: 'started' | 'completed' | 'failed'; description?: string; taskType?: string; summary?: string } }) {
  const isAgent = block.taskType === 'local_agent'
  const label = block.description || block.summary || (isAgent ? 'Subagent' : 'Background task')
  return (
    <div className="px-3 py-0.5">
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] ${
        block.status === 'started' ? 'border-border text-text-tertiary'
          : block.status === 'failed' ? 'border-destructive/40 text-destructive'
          : 'border-border text-text-secondary'
      }`}>
        {block.status === 'started'
          ? <Loader2 size={9} className="animate-spin" />
          : block.status === 'failed'
            ? <AlertTriangle size={9} />
            : <Check size={9} className="text-green-500" />}
        <span className="font-medium">{isAgent ? 'Agent' : 'Shell'}</span>
        <span className="truncate max-w-[40ch]">{label}</span>
        {block.status !== 'started' && block.summary && block.summary !== label && (
          <span className="text-text-quaternary truncate max-w-[40ch]">· {block.summary}</span>
        )}
      </span>
    </div>
  )
}

// --------------------------------------------------------------------------
// Result footer — per-turn cost/latency/model breakdown (subtle single line,
// expandable when a multi-model breakdown is present).
// --------------------------------------------------------------------------

function ResultFooterBlock({ block }: { block: { cost: number; tokens: { input: number; output: number; cacheRead?: number; cacheCreation?: number }; duration: number; ttftMs?: number; stopReason?: string | null; numTurns?: number; modelUsage?: Array<{ model: string; inputTokens: number; outputTokens: number; costUSD?: number }> } }) {
  const [expanded, setExpanded] = useState(false)
  const models = block.modelUsage?.filter((m) => m.outputTokens > 0 || m.inputTokens > 0) ?? []
  const shortModel = (id: string) => id.replace(/^arn:aws:bedrock:.*\//, 'arn:…/').replace(/^us\.anthropic\./, '')
  return (
    <div className="px-3 py-0.5">
      <button
        onClick={() => models.length > 0 && setExpanded(!expanded)}
        className={`flex items-center gap-2 text-[10px] text-text-quaternary ${models.length > 0 ? 'hover:text-text-tertiary cursor-pointer' : 'cursor-default'} transition-colors duration-fast`}
      >
        <span>{(block.duration / 1000).toFixed(1)}s</span>
        {block.ttftMs !== undefined && <span title="Time to first token">ttft {(block.ttftMs / 1000).toFixed(1)}s</span>}
        <span>${block.cost.toFixed(4)}</span>
        <span>{block.tokens.output.toLocaleString()} out</span>
        {block.stopReason && block.stopReason !== 'end_turn' && (
          <span className="text-warning">{block.stopReason}</span>
        )}
        {models.length > 1 && <span>· {models.length} models</span>}
      </button>
      {expanded && models.length > 0 && (
        <div className="mt-0.5 ml-2 space-y-px">
          {models.map((m) => (
            <div key={m.model} className="text-[10px] font-mono text-text-quaternary">
              {shortModel(m.model)}: {m.inputTokens.toLocaleString()} in · {m.outputTokens.toLocaleString()} out{m.costUSD !== undefined ? ` · $${m.costUSD.toFixed(4)}` : ''}
            </div>
          ))}
        </div>
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
// TodoWrite — render the agent's todo list as a real checklist instead of
// raw JSON. Each item shows a status glyph (pending / in-progress / completed)
// plus the active-form text while in progress, content otherwise.
// --------------------------------------------------------------------------

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

function TodoListBlock({ input }: { input: Record<string, unknown> }) {
  const todos = (Array.isArray(input.todos) ? input.todos : []) as TodoItem[]
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.find((t) => t.status === 'in_progress')

  return (
    <div className="px-3 py-1.5">
      <div className="flex items-center gap-1.5 text-xs text-text-secondary mb-1">
        <ListTodo size={11} className="flex-shrink-0" />
        <span className="font-medium">Todos</span>
        <span className="text-text-tertiary">{done}/{todos.length}</span>
        {inProgress && (
          <span className="text-text-tertiary truncate ml-1" title={inProgress.activeForm ?? inProgress.content}>
            · {inProgress.activeForm ?? inProgress.content}
          </span>
        )}
      </div>
      <ul className="space-y-0.5 ml-1">
        {todos.map((t, i) => {
          const label = t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content
          const cls = t.status === 'completed'
            ? 'text-text-tertiary line-through'
            : t.status === 'in_progress'
              ? 'text-text-primary font-medium'
              : 'text-text-secondary'
          return (
            <li key={i} className="flex items-start gap-1.5 text-xs leading-relaxed">
              <span className="mt-0.5 flex-shrink-0">
                {t.status === 'completed'
                  ? <Check size={11} className="text-success" />
                  : t.status === 'in_progress'
                    ? <Loader2 size={11} className="text-warning animate-spin" />
                    : <Circle size={11} className="text-text-tertiary" />}
              </span>
              <span className={`flex-1 min-w-0 break-words ${cls}`}>{label}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

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
          {/* Render markdown so hub-injected images (e.g. the WhatsApp pairing
              QR, sent as a `![](data:image/png;base64,…)` user_prompt) show as
              an <img> instead of raw base64. A <div> (not <p>) since the image
              is display:block — block-in-<p> is invalid and React closes the p early. */}
          <div className="text-sm text-text-primary whitespace-pre-wrap break-words">{renderInlineMarkdown(content)}</div>
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
// Code fence — fenced code block with optional language label + copy button
// --------------------------------------------------------------------------

function CodeFence({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore — clipboard may be blocked */ }
  }, [code])

  return (
    <div className="my-1 rounded-sm bg-surface-2 max-w-[calc(100vw-24px)] overflow-hidden">
      {(lang || true) && (
        <div className="flex items-center justify-between px-2 py-0.5 border-b border-border/40">
          <span className="text-[9px] text-text-tertiary uppercase tracking-wider">{lang || 'code'}</span>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-[9px] text-text-tertiary hover:text-text-primary transition-colors duration-fast"
            title="Copy code"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      )}
      <pre className="px-2 py-1.5 text-[11px] font-mono overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// --------------------------------------------------------------------------
// Mermaid diagram — renders SVG inline. Mermaid is heavy (~600KB) so it's
// dynamically imported, initialised once per page, and the import is shared
// across all MermaidBlock instances. Falls back to source-view-on-error and
// always offers a "show source" toggle + copy.
// --------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidPromise: Promise<any> | null = null
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const dark = document.documentElement.classList.contains('dark') ||
        window.matchMedia?.('(prefers-color-scheme: dark)').matches
      m.default.initialize({
        startOnLoad: false,
        theme: dark ? 'dark' : 'default',
        securityLevel: 'strict',          // disallow inline event handlers / HTML labels
        fontFamily: 'inherit',
      })
      return m.default
    })
  }
  return mermaidPromise
}

let mermaidIdCounter = 0

function MermaidBlock({ source }: { source: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        const id = `mermaid-${++mermaidIdCounter}`
        const { svg } = await mermaid.render(id, source)
        if (cancelled) return
        if (containerRef.current) containerRef.current.innerHTML = svg
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Failed to render diagram')
      }
    })()
    return () => { cancelled = true }
  }, [source])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard may be blocked */ }
  }, [source])

  return (
    <div className="my-1 rounded-sm bg-surface-2 max-w-[calc(100vw-24px)] overflow-hidden">
      <div className="flex items-center justify-between px-2 py-0.5 border-b border-border/40">
        <span className="text-[9px] text-text-tertiary uppercase tracking-wider">
          mermaid{error ? ' · error' : ''}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="text-[9px] text-text-tertiary hover:text-text-primary transition-colors duration-fast"
            title={showSource ? 'Show diagram' : 'Show source'}
          >
            {showSource ? 'diagram' : 'source'}
          </button>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-[9px] text-text-tertiary hover:text-text-primary transition-colors duration-fast"
            title="Copy source"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      </div>
      {showSource || error ? (
        <pre className="px-2 py-1.5 text-[11px] font-mono overflow-x-auto">
          {error && <div className="text-[10px] text-destructive mb-1">{error}</div>}
          <code>{source}</code>
        </pre>
      ) : (
        <div ref={containerRef} className="p-2 overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto" />
      )}
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
      lang === 'mermaid'
        ? <MermaidBlock key={key++} source={code} />
        : <CodeFence key={key++} lang={lang} code={code} />,
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

/** Allow only safe link schemes (blocks `javascript:`/`data:` href injection
 *  from agent output). Returns the href to use, or null to render as plain text. */
function safeHref(url: string): string | null {
  const u = url.trim()
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u
  if (u.startsWith('/') || u.startsWith('#')) return u
  return null
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let key = 0

  const link = (href: string, label: string) => (
    <a
      key={key++}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline break-all"
    >
      {label}
    </a>
  )

  // Handle image, markdown link, inline code, bold, italic, and bare URLs in one
  // pass. Image first so its `(...)` URL doesn't collide; markdown link next (the
  // `!` guard keeps it from stealing images); then code (so **bold** inside
  // backticks stays literal), bold, italic, and finally bare-URL autolinking.
  const inlineRegex = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|(https?:\/\/[^\s<]+)/g
  let lastIndex = 0

  for (const match of text.matchAll(inlineRegex)) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>)
    }
    if (match[1] !== undefined && match[2] !== undefined) {
      // Image
      parts.push(
        <img
          key={key++}
          alt={match[1]}
          src={match[2]}
          className="block max-h-64 max-w-xs my-1 rounded border border-border object-contain"
        />,
      )
    } else if (match[3] !== undefined && match[4] !== undefined) {
      // Markdown link [text](url) — fall back to literal text on an unsafe scheme.
      const href = safeHref(match[4])
      parts.push(href ? link(href, match[3]) : <span key={key++}>{match[0]}</span>)
    } else if (match[5] !== undefined) {
      // Inline code
      parts.push(
        <code key={key++} className="bg-surface-2 px-1 py-0.5 rounded-sm text-[11px] font-mono break-all">
          {match[5]}
        </code>,
      )
    } else if (match[6] !== undefined) {
      // Bold
      parts.push(<strong key={key++} className="font-semibold">{match[6]}</strong>)
    } else if (match[7] !== undefined) {
      // Italic
      parts.push(<em key={key++}>{match[7]}</em>)
    } else if (match[8] !== undefined) {
      // Bare URL — strip trailing sentence punctuation back into the text run.
      let url = match[8]
      let trailing = ''
      const tp = url.match(/[.,;:!?]+$/)
      if (tp) { trailing = tp[0]; url = url.slice(0, -trailing.length) }
      parts.push(link(url, url))
      if (trailing) parts.push(<span key={key++}>{trailing}</span>)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIndex)}</span>)
  }

  return parts.length > 0 ? parts : [<span key={0}>{text}</span>]
}
