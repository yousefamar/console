// Fleet-wide agent controls for the Spaces pane — model picker, backend
// switch, fallback notice. These are hub-level levers (not per-space), so
// they live in a small gear popover in the rail header rather than a
// persistent footer. Mirrors the AgentTab sidebar footer's semantics; the
// model lists deliberately duplicate AgentTab's (same ids, same reasoning:
// the same model needs a different id per backend and the wrong form 400s).

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Loader2, Settings } from 'lucide-react'
import clsx from 'clsx'
import { useAgentStore } from '@/store/agent'
import { displayModel } from '@/utils/model-label'

const FIRST_PARTY_MODELS = [
  'claude-opus-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

const BEDROCK_MODELS = [
  'us.anthropic.claude-opus-5',
  'us.anthropic.claude-fable-5',
  'us.anthropic.claude-opus-4-8',
  'us.anthropic.claude-opus-4-7',
  'us.anthropic.claude-sonnet-5',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
] as const

export function SpacesFleetMenu() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const modelFallbackNotice = useAgentStore((s) => s.modelFallbackNotice)

  // The rail this button sits in clips overflow (a real file tree needs a
  // scrollbar), so `position: absolute` got silently clipped to the rail's
  // width — visible only as a sliver of cut-off labels with no controls.
  // `fixed`, positioned from the button's own rect, escapes that ancestor.
  useEffect(() => {
    if (!open || !btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setPos({ left: rect.left, top: rect.bottom + 4 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={clsx('transition-colors', modelFallbackNotice ? 'text-amber-400 hover:text-amber-300' : 'text-text-tertiary hover:text-text-primary')}
        title="Fleet settings (model, backend)"
      >
        <Settings size={11} />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="fixed z-40 w-72 rounded border border-border bg-surface-0 p-2 shadow-xl space-y-2"
          style={{ left: pos.left, top: pos.top }}
        >
          <FallbackNotice />
          <ModelPicker />
          <BackendSwitch />
        </div>
      )}
    </>
  )
}

function FallbackNotice() {
  const notice = useAgentStore((s) => s.modelFallbackNotice)
  const dismiss = useAgentStore((s) => s.dismissModelFallbackNotice)
  if (!notice) return null
  return (
    <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-300">
      <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
      <span className="flex-1 leading-snug">
        <span className="font-mono">{notice.failedModel}</span> was unavailable — fell back to <span className="font-mono">{notice.model}</span>.
      </span>
      <button onClick={dismiss} className="flex-shrink-0 text-amber-300/70 hover:text-amber-200" title="Dismiss">
        <Check size={12} />
      </button>
    </div>
  )
}

function ModelPicker() {
  const agentModel = useAgentStore((s) => s.agentModel)
  const agentModelChain = useAgentStore((s) => s.agentModelChain)
  const lockedByEnv = useAgentStore((s) => s.agentModelLockedByEnv)
  const setAgentModel = useAgentStore((s) => s.setAgentModel)
  const connected = useAgentStore((s) => s.connected)
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-text-tertiary flex-shrink-0 w-12">Model</span>
      <select
        value={agentModel}
        onChange={(e) => setAgentModel(e.target.value)}
        disabled={lockedByEnv || !connected || agentModelChain.length === 0}
        className="flex-1 min-w-0 bg-transparent text-[11px] text-text-secondary outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 truncate"
        title={lockedByEnv ? 'Locked by CLAUDE_MODEL env var' : `Model all hub agents spawn with.\n${agentModel}`}
      >
        {agentModel && !agentModelChain.includes(agentModel) && (
          <option value={agentModel}>{displayModel(agentModel)}</option>
        )}
        {agentModelChain.map((m, i) => (
          <option key={m} value={m}>{displayModel(m)}{i === 0 ? '' : ` (fallback ${i})`}</option>
        ))}
        <optgroup label="──────────"></optgroup>
        <optgroup label="Direct (first-party)">
          {FIRST_PARTY_MODELS.filter((m) => !agentModelChain.includes(m)).map((m) => (
            <option key={m} value={m}>{displayModel(m)}</option>
          ))}
        </optgroup>
        <optgroup label="Bedrock">
          {BEDROCK_MODELS.filter((m) => !agentModelChain.includes(m)).map((m) => (
            <option key={m} value={m}>{displayModel(m)}</option>
          ))}
        </optgroup>
      </select>
      {lockedByEnv && <span className="text-[9px] uppercase tracking-wider text-amber-400/80" title="Pinned by CLAUDE_MODEL">env</span>}
    </div>
  )
}

function BackendSwitch() {
  const agentBackend = useAgentStore((s) => s.agentBackend)
  const setAgentBackend = useAgentStore((s) => s.setAgentBackend)
  const connected = useAgentStore((s) => s.connected)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const switchTo = useCallback(async (backend: 'first_party' | 'bedrock') => {
    if (backend === agentBackend || switching) return
    setSwitching(true)
    setError(null)
    try {
      await setAgentBackend(backend)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSwitching(false)
    }
  }, [agentBackend, switching, setAgentBackend])

  const btn = (id: 'first_party' | 'bedrock', label: string, title: string) => (
    <button
      onClick={() => void switchTo(id)}
      disabled={!connected || switching}
      title={title}
      className={clsx(
        'flex-1 px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed',
        agentBackend === id ? 'bg-accent/20 text-accent' : 'text-text-tertiary hover:text-text-secondary disabled:opacity-60',
      )}
    >
      {label}
    </button>
  )

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-text-tertiary flex-shrink-0 w-12">Backend</span>
        <div className="flex-1 flex items-center border border-border rounded-sm overflow-hidden">
          {btn('first_party', 'Max sub', 'Claude Max subscription — fixed cost, session limits under fleet load')}
          <div className="w-px bg-border self-stretch" />
          {btn('bedrock', 'Bedrock', 'Amazon Bedrock — pay-per-token, no session limits')}
        </div>
        {switching && <Loader2 size={11} className="animate-spin text-text-tertiary flex-shrink-0" />}
      </div>
      {error && <div className="mt-1 text-[10px] text-destructive">{error}</div>}
    </div>
  )
}
