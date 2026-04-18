import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useAgentStore, type PendingApproval } from '@/store/agent'
import { ShieldAlert, Terminal, Pencil, FileText, MessageCircleQuestion, ClipboardList } from 'lucide-react'
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

function AskUserQuestionUI({ approval }: Props) {
  const approveTool = useAgentStore((s) => s.approveTool)
  const { requestId, input } = approval

  // AskUserQuestion input has a `questions` array — extract the first question
  const questions = (input.questions ?? []) as Array<{ question: string; header?: string; options?: AskUserQuestionOption[]; multiSelect?: boolean }>
  const firstQ = questions[0]
  const question = firstQ?.question ?? String(input.question ?? '')
  const options = (firstQ?.options ?? input.options ?? []) as AskUserQuestionOption[]
  const multiSelect = firstQ?.multiSelect ?? (input.multiSelect as boolean | undefined)

  const [answer, setAnswer] = useState('')
  const [selectedOptions, setSelectedOptions] = useState<Set<number>>(new Set())
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Auto-focus the text input
    inputRef.current?.focus()
  }, [requestId])

  const submit = useCallback(() => {
    let result: string
    if (options.length > 0) {
      const selected = [...selectedOptions].map((i) => options[i]!.label)
      // Include free-form text if provided alongside selections
      if (answer.trim()) selected.push(answer.trim())
      result = selected.join(', ') || answer.trim()
    } else {
      result = answer.trim()
    }
    if (!result) return
    // AskUserQuestion expects original questions array + answers keyed by question text
    const answers: Record<string, string> = {}
    answers[question] = result
    approveTool(requestId, { questions: input.questions, answers })
  }, [approveTool, requestId, options, selectedOptions, answer, question])

  const toggleOption = useCallback((index: number) => {
    setSelectedOptions((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        if (!multiSelect) next.clear()
        next.add(index)
      }
      return next
    })
  }, [multiSelect])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }, [submit])

  return (
    <div className="border-t border-border bg-surface-1 animate-slide-up">
      <div className="px-3 py-2">
        {/* Header */}
        <div className="flex items-center gap-1.5 mb-2">
          <MessageCircleQuestion size={13} className="text-blue-400" />
          <span className="text-xs font-medium text-text-primary">Claude is asking</span>
        </div>

        {/* Question */}
        <p className="text-sm text-text-primary mb-2">{question}</p>

        {/* Options (if any) */}
        {options.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {options.map((opt, i) => (
              <button
                key={i}
                onClick={() => toggleOption(i)}
                className={`text-left px-2 py-1.5 rounded-sm text-xs transition-colors duration-fast border ${
                  selectedOptions.has(i)
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

        {/* Answer input */}
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={options.length > 0 ? 'Select above or type a response...' : 'Type your response...'}
            rows={1}
            className="flex-1 bg-surface-2 border border-border rounded-sm px-2 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:border-blue-400/50"
          />
          <button
            onClick={submit}
            disabled={!answer.trim() && selectedOptions.size === 0}
            className="px-3 py-1.5 text-xs font-medium rounded-sm bg-blue-400/20 text-blue-400 hover:bg-blue-400/30 transition-colors duration-fast disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
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
