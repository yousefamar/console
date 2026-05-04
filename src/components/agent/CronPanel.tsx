import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cron } from 'croner'
import { Play, Trash2, X, Plus, Calendar, Repeat, Copy } from 'lucide-react'
import { useCronStore, type HubCronTask } from '@/store/cron'

interface Props {
  claudeSessionId: string | undefined
  onClose: () => void
}

/**
 * Side-panel: lists scheduled tasks for one session and lets the user add /
 * run / delete them. The "Subscribe in calendar" button surfaces the ICS URL.
 *
 * Why per-session: the v1 surface is keyed by which session the user is
 * looking at. A future global "all tasks" view can come later.
 */
export function CronPanel({ claudeSessionId, onClose }: Props) {
  const tasks = useCronStore((s) => claudeSessionId ? (s.tasksBySession[claudeSessionId] ?? []) : [])
  const refresh = useCronStore((s) => s.refresh)
  const remove = useCronStore((s) => s.remove)
  const runOnce = useCronStore((s) => s.runOnce)
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    if (claudeSessionId) refresh(claudeSessionId)
  }, [claudeSessionId, refresh])

  if (!claudeSessionId) return null

  return (
    <div className="absolute inset-y-0 right-0 z-30 w-80 max-w-full border-l border-border bg-surface-1 shadow-lg flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text-primary">Scheduled prompts</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="text-text-tertiary hover:text-text-primary transition-colors"
            title={showCreate ? 'Hide form' : 'New scheduled task'}
          >
            <Plus size={14} className={`transition-transform ${showCreate ? 'rotate-45' : ''}`} />
          </button>
          <button type="button" onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors" title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="border-b border-border">
          <CreateForm claudeSessionId={claudeSessionId} onDone={() => setShowCreate(false)} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 && !showCreate && (
          <div className="px-3 py-6 text-center text-xs text-text-tertiary">
            No scheduled prompts for this session.
          </div>
        )}
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            onRun={() => runOnce(t.id)}
            onRemove={() => { void remove(t.id) }}
          />
        ))}
      </div>

      <div className="border-t border-border">
        <IcsRow />
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------

function TaskRow({ task, onRun, onRemove }: { task: HubCronTask; onRun: () => void; onRemove: () => void }) {
  const nextFire = useMemo(() => {
    try { return new Cron(task.trigger).nextRun() ?? null } catch { return null }
  }, [task.trigger])

  const lastFiredAgo = task.lastFiredAt ? formatRelativeAgo(Date.now() - task.lastFiredAt) : null
  const nextIn = nextFire ? formatRelativeIn(nextFire.getTime() - Date.now()) : null

  return (
    <div className="px-3 py-2 border-b border-border/50">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-text-tertiary flex-shrink-0">
              {task.recurring ? <Repeat size={10} /> : <Calendar size={10} />}
            </span>
            <code className="text-[11px] text-text-secondary truncate">{task.trigger}</code>
            {task.disabledAt && (
              <span className="text-[10px] text-destructive flex-shrink-0">disabled</span>
            )}
          </div>
          <div className="text-xs text-text-primary line-clamp-2 break-words" title={task.prompt}>
            {task.prompt}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5 flex items-center gap-2 flex-wrap">
            {nextIn && !task.disabledAt && <span>next {nextIn}</span>}
            {lastFiredAgo && <span>fired {lastFiredAgo}</span>}
            {task.lastSkipReason && <span className="text-yellow-400" title={`${task.consecutiveSkips} consecutive skips`}>skip: {task.lastSkipReason}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={onRun} className="text-text-tertiary hover:text-text-primary p-1" title="Run now">
            <Play size={11} />
          </button>
          <button onClick={onRemove} className="text-text-tertiary hover:text-destructive p-1" title="Delete">
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------

function CreateForm({ claudeSessionId, onDone }: { claudeSessionId: string; onDone: () => void }) {
  const add = useCronStore((s) => s.add)
  const [mode, setMode] = useState<'recurring' | 'oneshot'>('recurring')
  const [cronExpr, setCronExpr] = useState('*/5 * * * *')
  const [datetime, setDatetime] = useState(() => {
    const d = new Date(Date.now() + 30 * 60_000)
    // local datetime-local format: YYYY-MM-DDTHH:mm
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trigger = mode === 'recurring' ? cronExpr : new Date(datetime).toISOString()
  const recurring = mode === 'recurring'

  const previewFires = useMemo(() => {
    if (mode !== 'recurring') return []
    try {
      const c = new Cron(cronExpr)
      const out: Date[] = []
      let cursor: Date | undefined
      for (let i = 0; i < 3; i++) {
        const next = c.nextRun(cursor)
        if (!next) break
        out.push(next)
        cursor = next
      }
      return out
    } catch {
      return null
    }
  }, [mode, cronExpr])

  const triggerError = useMemo(() => {
    if (mode === 'recurring') {
      try { new Cron(cronExpr); return null } catch (e) { return (e as Error).message }
    }
    const t = Date.parse(datetime)
    if (!Number.isFinite(t)) return 'Invalid datetime'
    if (t <= Date.now()) return 'Datetime is in the past'
    return null
  }, [mode, cronExpr, datetime])

  const submit = useCallback(async () => {
    if (triggerError || !prompt.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await add({ claudeSessionId, trigger, prompt, recurring })
      setPrompt('')
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }, [add, claudeSessionId, trigger, prompt, recurring, triggerError, onDone])

  return (
    <div className="px-3 py-2 space-y-2">
      <div className="flex items-center gap-1 text-[11px]">
        <button
          type="button"
          onClick={() => setMode('recurring')}
          className={`px-2 py-0.5 rounded-sm transition-colors ${mode === 'recurring' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-primary'}`}
        >Recurring</button>
        <button
          type="button"
          onClick={() => setMode('oneshot')}
          className={`px-2 py-0.5 rounded-sm transition-colors ${mode === 'oneshot' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-primary'}`}
        >One-shot</button>
      </div>

      {mode === 'recurring' ? (
        <div>
          <input
            type="text"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            placeholder="*/5 * * * *"
            className="w-full bg-surface-2 border border-border rounded-sm px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-blue-400/50"
          />
          {previewFires && previewFires.length > 0 && (
            <div className="text-[10px] text-text-tertiary mt-1">
              next: {previewFires.map((d) => d.toLocaleString()).join(' · ')}
            </div>
          )}
          {triggerError && <div className="text-[10px] text-destructive mt-1">{triggerError}</div>}
        </div>
      ) : (
        <div>
          <input
            type="datetime-local"
            value={datetime}
            onChange={(e) => setDatetime(e.target.value)}
            className="w-full bg-surface-2 border border-border rounded-sm px-2 py-1 text-xs text-text-primary outline-none focus:border-blue-400/50"
          />
          <div className="flex gap-1 mt-1 text-[10px]">
            {[
              { label: '+15m', ms: 15 * 60_000 },
              { label: '+1h',  ms: 60 * 60_000 },
              { label: '+1d',  ms: 24 * 60 * 60_000 },
            ].map(({ label, ms }) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  const d = new Date(Date.now() + ms)
                  const pad = (n: number) => String(n).padStart(2, '0')
                  setDatetime(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
                }}
                className="px-1.5 py-0.5 rounded-sm bg-surface-2 hover:bg-surface-3 text-text-secondary"
              >{label}</button>
            ))}
          </div>
          {triggerError && <div className="text-[10px] text-destructive mt-1">{triggerError}</div>}
        </div>
      )}

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Prompt to send (verbatim) on each fire..."
        rows={3}
        className="w-full bg-surface-2 border border-border rounded-sm px-2 py-1 text-xs text-text-primary outline-none focus:border-blue-400/50 resize-none"
      />

      {error && <div className="text-[11px] text-destructive">{error}</div>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
        >Cancel</button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !!triggerError || !prompt.trim()}
          className="px-3 py-1 text-xs font-medium rounded-sm bg-blue-400/20 text-blue-400 hover:bg-blue-400/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >Schedule</button>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------

function IcsRow() {
  const fetchToken = useCronStore((s) => s.fetchIcsToken)
  const isPublic = useCronStore((s) => !!s.icsPublicUrl)
  const url = useCronStore((s) => s.icsUrl())
  const [copied, setCopied] = useState(false)

  useEffect(() => { void fetchToken() }, [fetchToken])

  const copy = useCallback(async () => {
    if (!url) return
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }, [url])

  if (!url) return null
  return (
    <div className="px-3 py-2 flex items-center gap-2">
      <Calendar size={11} className="text-text-tertiary flex-shrink-0" />
      <span
        className="text-[10px] text-text-tertiary flex-1 truncate"
        title={isPublic ? 'Public via Tailscale Funnel — works in GCal' : 'Tailnet-only — only reachable on your tailnet'}
      >
        {isPublic ? 'Calendar URL (public)' : 'Calendar URL (tailnet)'}
      </span>
      <button
        type="button"
        onClick={copy}
        className="text-[10px] text-text-tertiary hover:text-text-primary flex items-center gap-1"
        title={url}
      >
        <Copy size={10} />
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}

// --------------------------------------------------------------------------

function formatRelativeIn(ms: number): string {
  if (ms <= 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

function formatRelativeAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
