import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useAgentStore, type PendingApproval } from '@/store/agent'
import { ShieldAlert, Terminal, Pencil, FileText, MessageCircleQuestion, ClipboardList, ChevronLeft, ChevronRight, Check } from 'lucide-react'
import { renderMarkdownLite } from './AgentMessageBlock'

// ============================================================================
// AgentToolApproval — bottom sheet that appears when Claude wants to use a
// tool that requires permission. Shows the tool name and input, with
// Allow / Deny / Allow All buttons.
//
// Special handling for AskUserQuestion: shows the question with options
// (if any) and a text input for the user's answer.
// ============================================================================

interface Props {
  approval: PendingApproval
}

export function AgentToolApproval({ approval }: Props) {
  if (approval.toolName === 'AskUserQuestion') {
    return <AskUserQuestionUI approval={approval} />
  }
  if (approval.toolName === 'ExitPlanMode') {
    return <PlanApprovalUI approval={approval} />
  }
  return <ToolPermissionUI approval={approval} />
}

// --------------------------------------------------------------------------
// AskUserQuestion — renders question, options, and answer input
// --------------------------------------------------------------------------

interface AskUserQuestionOption {
  label: string
  description?: string
}

interface AskUserQuestion {
  question: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

function AskUserQuestionUI({ approval }: Props) {
  const approveTool = useAgentStore((s) => s.approveTool)
  const { requestId, input } = approval

  // Normalize: tool may pass `questions: [...]` or a single question via legacy
  // top-level `question` / `options` / `multiSelect` fields.
  const questions: AskUserQuestion[] = (input.questions as AskUserQuestion[] | undefined) ?? (
    input.question
      ? [{ question: String(input.question), options: input.options as AskUserQuestionOption[] | undefined, multiSelect: input.multiSelect as boolean | undefined }]
      : []
  )

  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''))
  const [selections, setSelections] = useState<Set<number>[]>(() => questions.map(() => new Set<number>()))
  const [page, setPage] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Reset state when a new approval arrives
    setAnswers(questions.map(() => ''))
    setSelections(questions.map(() => new Set<number>()))
    setPage(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  // Focus the textarea whenever we land on a new page
  useEffect(() => {
    inputRef.current?.focus()
  }, [page, requestId])

  const setAnswerAt = useCallback((i: number, val: string) => {
    setAnswers((prev) => {
      const next = [...prev]
      next[i] = val
      return next
    })
  }, [])

  const toggleOption = useCallback((qIdx: number, optIdx: number) => {
    setSelections((prev) => {
      const next = prev.map((s) => new Set(s))
      const set = next[qIdx]!
      const q = questions[qIdx]!
      if (set.has(optIdx)) {
        set.delete(optIdx)
      } else {
        if (!q.multiSelect) set.clear()
        set.add(optIdx)
      }
      return next
    })
  }, [questions])

  /** Build the per-question answer array. Schema is Record<question, string[]>:
   *  one entry per selected option label, plus the free-form text if any. */
  const buildAnswerFor = (qIdx: number): string[] => {
    const q = questions[qIdx]!
    const opts = q.options ?? []
    const free = answers[qIdx]?.trim() ?? ''
    const out: string[] = []
    if (opts.length > 0) {
      for (const i of selections[qIdx] ?? new Set()) out.push(opts[i]!.label)
    }
    if (free) out.push(free)
    return out
  }

  const isAnswered = (i: number) => buildAnswerFor(i).length > 0
  const allAnswered = questions.every((_, i) => isAnswered(i))

  const submit = useCallback(() => {
    if (!allAnswered) return
    const out: Record<string, string[]> = {}
    for (let i = 0; i < questions.length; i++) {
      out[questions[i]!.question] = buildAnswerFor(i)
    }
    approveTool(requestId, { questions, answers: out })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveTool, requestId, allAnswered, questions, answers, selections])

  const goPrev = useCallback(() => setPage((p) => Math.max(0, p - 1)), [])
  const goNext = useCallback(() => setPage((p) => Math.min(questions.length - 1, p + 1)), [questions.length])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const isLast = page === questions.length - 1
    if (e.key === 'Enter' && !e.shiftKey) {
      // Cmd/Ctrl+Enter sends from anywhere; plain Enter advances or sends on last
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return }
      e.preventDefault()
      if (isLast) submit()
      else goNext()
    }
  }, [page, questions.length, submit, goNext])

  if (questions.length === 0) return null

  const q = questions[page]!
  const opts = q.options ?? []
  const selected = selections[page] ?? new Set<number>()
  const multi = questions.length > 1

  return (
    <div className="border-t border-border bg-surface-1 animate-slide-up">
      <div className="px-3 py-2 max-h-[60vh] overflow-y-auto">
        {/* Header — title + page counter */}
        <div className="flex items-center justify-between gap-1.5 mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <MessageCircleQuestion size={13} className="text-blue-400 flex-shrink-0" />
            <span className="text-xs font-medium text-text-primary truncate">
              {multi ? `Claude is asking · ${page + 1}/${questions.length}` : 'Claude is asking'}
            </span>
          </div>
        </div>

        {q.header && (
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">{q.header}</div>
        )}
        <p className="text-sm text-text-primary mb-2">{q.question}</p>

        {opts.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {opts.map((opt, i) => (
              <button
                key={i}
                onClick={() => toggleOption(page, i)}
                className={`text-left px-2 py-1.5 rounded-sm text-xs transition-colors duration-fast border ${
                  selected.has(i)
                    ? 'border-blue-400/50 bg-blue-400/10 text-text-primary'
                    : 'border-border bg-surface-2 text-text-secondary hover:bg-surface-3'
                }`}
              >
                <span className="font-medium">{opt.label}</span>
                {opt.description && (
                  <span className="text-text-tertiary ml-1.5">— {opt.description}</span>
                )}
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          value={answers[page] ?? ''}
          onChange={(e) => setAnswerAt(page, e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={opts.length > 0 ? 'Select above or type a response...' : 'Type your response...'}
          rows={1}
          className="w-full bg-surface-2 border border-border rounded-sm px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:border-blue-400/50"
        />

        {/* Footer: dots + nav + send */}
        <div className="flex items-center gap-2 mt-2">
          {multi && (
            <button
              type="button"
              onClick={goPrev}
              disabled={page === 0}
              className="p-1 text-text-tertiary hover:text-text-primary transition-colors duration-fast disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous"
            >
              <ChevronLeft size={14} />
            </button>
          )}
          {multi && (
            <div className="flex items-center gap-1.5">
              {questions.map((_, i) => {
                const done = isAnswered(i)
                const here = i === page
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setPage(i)}
                    title={`Question ${i + 1}${done ? ' (answered)' : ''}`}
                    className={`flex items-center justify-center rounded-full transition-all duration-fast ${
                      here
                        ? 'w-2 h-2 bg-blue-400'
                        : done
                          ? 'w-2 h-2 bg-blue-400/50 hover:bg-blue-400/80'
                          : 'w-2 h-2 bg-border hover:bg-text-tertiary'
                    }`}
                  />
                )
              })}
            </div>
          )}
          {multi && (
            <button
              type="button"
              onClick={goNext}
              disabled={page === questions.length - 1}
              className="p-1 text-text-tertiary hover:text-text-primary transition-colors duration-fast disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next (Enter)"
            >
              <ChevronRight size={14} />
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={submit}
            disabled={!allAnswered}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-sm bg-blue-400/20 text-blue-400 hover:bg-blue-400/30 transition-colors duration-fast disabled:opacity-40 disabled:cursor-not-allowed"
            title={multi ? 'Cmd/Ctrl+Enter to send' : 'Enter to send'}
          >
            <Check size={12} />
            <span>Send{multi ? ` all (${questions.filter((_, i) => isAnswered(i)).length}/${questions.length})` : ''}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// ExitPlanMode — shows the plan formatted for review before approval
// --------------------------------------------------------------------------

function PlanApprovalUI({ approval }: Props) {
  const approveTool = useAgentStore((s) => s.approveTool)
  const denyTool = useAgentStore((s) => s.denyTool)
  const { requestId, input } = approval
  const plan = String(input.plan ?? '')
  const rendered = useMemo(() => renderMarkdownLite(plan), [plan])

  return (
    <div className="border-t border-border bg-surface-1 animate-slide-up">
      <div className="px-3 py-2">
        {/* Header */}
        <div className="flex items-center gap-1.5 mb-2">
          <ClipboardList size={13} className="text-blue-400" />
          <span className="text-xs font-medium text-text-primary">Plan ready for review</span>
        </div>

        {/* Plan content */}
        <div className="rounded-sm border border-border bg-surface-0 px-3 py-2 max-h-[50vh] overflow-y-auto text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed mb-2">
          {rendered}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => approveTool(requestId)}
            className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-sm bg-success/20 text-success hover:bg-success/30 transition-colors duration-fast"
          >
            <span>Approve</span>
            <kbd className="text-[9px] opacity-60 ml-0.5">y</kbd>
          </button>
          <button
            onClick={() => denyTool(requestId, 'Plan rejected')}
            className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-sm bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors duration-fast"
          >
            <span>Reject</span>
            <kbd className="text-[9px] opacity-60 ml-0.5">n</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Standard tool permission UI
// --------------------------------------------------------------------------

function ToolPermissionUI({ approval }: Props) {
  const approveTool = useAgentStore((s) => s.approveTool)
  const denyTool = useAgentStore((s) => s.denyTool)
  const autoApproveTool = useAgentStore((s) => s.autoApproveTool)

  const { requestId, toolName, input } = approval

  return (
    <div className="border-t border-border bg-surface-1 animate-slide-up">
      <div className="px-3 py-2">
        {/* Header */}
        <div className="flex items-center gap-1.5 mb-2">
          <ShieldAlert size={13} className="text-warning" />
          <span className="text-xs font-medium text-text-primary">Permission required</span>
          <span className="text-xs text-text-tertiary">
            — {toolName}
          </span>
        </div>

        {/* Tool input preview */}
        <ToolInputPreview toolName={toolName} input={input} />

        {/* Actions */}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={() => approveTool(requestId)}
            className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-sm bg-success/20 text-success hover:bg-success/30 transition-colors duration-fast"
          >
            <span>Allow</span>
            <kbd className="text-[9px] opacity-60 ml-0.5">y</kbd>
          </button>
          <button
            onClick={() => denyTool(requestId, 'Denied by user')}
            className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-sm bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors duration-fast"
          >
            <span>Deny</span>
            <kbd className="text-[9px] opacity-60 ml-0.5">n</kbd>
          </button>
          <button
            onClick={() => autoApproveTool(toolName)}
            className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-sm bg-surface-2 text-text-secondary hover:bg-surface-3 transition-colors duration-fast"
            title={`Auto-approve all ${toolName} calls this session`}
          >
            <span>Allow all {toolName}</span>
            <kbd className="text-[9px] opacity-60 ml-0.5">a</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Tool-specific input previews
// --------------------------------------------------------------------------

function ToolInputPreview({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  switch (toolName) {
    case 'Bash':
      return (
        <div className="flex items-start gap-1.5 rounded-sm bg-surface-2 px-2 py-1.5 min-w-0 overflow-hidden">
          <Terminal size={12} className="text-text-tertiary mt-0.5 flex-shrink-0" />
          <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-all min-w-0">
            {String(input.command ?? '')}
          </pre>
        </div>
      )

    case 'Edit':
      return (
        <div className="space-y-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-1.5 text-xs text-text-secondary min-w-0">
            <Pencil size={11} className="flex-shrink-0" />
            <span className="font-mono break-all min-w-0">{String(input.file_path ?? '')}</span>
          </div>
          {input.old_string != null && (
            <div className="rounded-sm bg-surface-2 px-2 py-1 text-[11px] font-mono overflow-x-auto max-h-24 overflow-y-auto">
              <div className="text-red-400/80 line-through whitespace-pre-wrap break-words">{String(input.old_string)}</div>
              <div className="text-success whitespace-pre-wrap break-words mt-0.5">{String(input.new_string ?? '')}</div>
            </div>
          )}
        </div>
      )

    case 'Write':
      return (
        <div className="flex items-center gap-1.5 text-xs text-text-secondary min-w-0">
          <FileText size={11} className="flex-shrink-0" />
          <span className="font-mono break-all min-w-0">{String(input.file_path ?? '')}</span>
          <span className="text-text-tertiary flex-shrink-0">
            ({String(input.content ?? '').length} chars)
          </span>
        </div>
      )

    default:
      return (
        <pre className="rounded-sm bg-surface-2 px-2 py-1 text-[11px] font-mono text-text-secondary overflow-x-auto max-h-24 overflow-y-auto max-w-full">
          {JSON.stringify(input, null, 2)}
        </pre>
      )
  }
}
