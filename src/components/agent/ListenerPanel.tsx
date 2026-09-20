import { useEffect } from 'react'
import { X, Pause, Play, Trash2, Zap, Radio, GitFork } from 'lucide-react'
import { useListenersStore, type HubListener, type ListenerAction } from '@/store/listeners'
import { formatRelativeAgo, formatRelativeIn } from '@/utils/date'

interface Props {
  claudeSessionId: string | undefined
  onClose: () => void
}

/** Side-panel twin of CronPanel: the event listeners this session owns, what
 *  each fired last, pause/resume/flush/remove. Rules are registered from the
 *  session itself (`con listen add`) — there is no create form here. */
export function ListenerPanel({ claudeSessionId, onClose }: Props) {
  const listeners = useListenersStore((s) => claudeSessionId ? (s.bySession[claudeSessionId] ?? []) : [])
  const error = useListenersStore((s) => claudeSessionId ? s.errorBySession[claudeSessionId] : undefined)
  const refresh = useListenersStore((s) => s.refresh)
  const pause = useListenersStore((s) => s.pause)
  const resume = useListenersStore((s) => s.resume)
  const flush = useListenersStore((s) => s.flush)
  const remove = useListenersStore((s) => s.remove)

  useEffect(() => {
    if (claudeSessionId) refresh(claudeSessionId)
  }, [claudeSessionId, refresh])

  if (!claudeSessionId) return null

  return (
    <div className="absolute inset-y-0 right-0 z-30 w-80 max-w-full border-l border-border bg-surface-1 shadow-lg flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text-primary">Event listeners</span>
        <button type="button" onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors" title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && <div className="px-3 py-2 text-[10px] text-destructive break-words">{error}</div>}
        {listeners.length === 0 && !error && (
          <div className="px-3 py-6 text-center text-xs text-text-tertiary">
            No listeners for this session.
          </div>
        )}
        {listeners.map((l) => (
          <ListenerRow
            key={l.id}
            listener={l}
            onPause={() => { void pause(l.id) }}
            onResume={() => { void resume(l.id) }}
            onFlush={() => { void flush(l.id) }}
            onRemove={() => { void remove(l.id) }}
          />
        ))}
      </div>

      <div className="border-t border-border px-3 py-2 text-[10px] text-text-tertiary">
        <code>con listen add --on &lt;topic&gt; …</code>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------

function ListenerRow({ listener: l, onPause, onResume, onFlush, onRemove }: {
  listener: HubListener
  onPause: () => void
  onResume: () => void
  onFlush: () => void
  onRemove: () => void
}) {
  const stats = l.stats ?? {}
  const where = l.where ?? []
  const now = Date.now()
  const lastFired = stats.lastFiredAt ? formatRelativeAgo(now - stats.lastFiredAt) : null
  const outcome = stats.lastOutcome
  const outcomeBad = !!outcome && /^(skipped|error|paused|dropped)/.test(outcome)
  const gates = [
    l.coalesceMs ? `coalesce ${fmtDur(l.coalesceMs)}` : '',
    l.cooldownMs ? `cooldown ${fmtDur(l.cooldownMs)}` : '',
    [l.days, l.hours].filter(Boolean).join(' '),
    l.guard ? 'guard' : '',
  ].filter(Boolean)
  const life = [
    l.times !== undefined ? (l.timesTotal === 1 ? 'once' : `${l.times}/${l.timesTotal ?? l.times} left`) : '',
    l.expiresAt ? (l.expiresAt > now ? `expires ${formatRelativeIn(l.expiresAt - now)}` : 'expired') : '',
  ].filter(Boolean)

  return (
    <div className={`px-3 py-2 border-b border-border/50 ${l.disabledAt ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 min-w-0">
            <Radio size={10} className={`flex-shrink-0 ${l.pausedAt || l.disabledAt ? 'text-text-tertiary' : 'text-success'}`} />
            <code className="text-[11px] text-text-secondary truncate" title={`${l.on}${where.length ? ` where ${whereText(where)}` : ''}`}>
              {l.on}
              {where.length > 0 && <span className="text-text-tertiary"> where {whereText(where)}</span>}
            </code>
            {l.disabledAt ? (
              <span className="text-[10px] text-destructive flex-shrink-0">disabled</span>
            ) : l.pausedAt ? (
              <span className="text-[10px] text-yellow-400 flex-shrink-0" title={l.pauseReason}>paused</span>
            ) : l.pending ? (
              <span className="text-[10px] text-text-tertiary flex-shrink-0" title={`fires ${formatRelativeIn(l.pending.dueAt - now)}`}>pending {l.pending.events.length}</span>
            ) : null}
          </div>
          <div className="text-xs text-text-primary line-clamp-2 break-words flex items-start gap-1" title={describeAction(l.action)}>
            {l.action.type === 'wake' && l.action.fork && <GitFork size={10} className="flex-shrink-0 mt-0.5 text-text-tertiary" />}
            <span>{describeAction(l.action)}</span>
          </div>
          {l.name && <div className="text-[10px] text-text-secondary truncate">{l.name}</div>}
          <div className="text-[10px] text-text-tertiary mt-0.5 flex items-center gap-2 flex-wrap">
            <span>fired {stats.fired ?? 0}{lastFired ? ` · ${lastFired}` : ''}</span>
            {(stats.matched ?? 0) > (stats.fired ?? 0) && <span>matched {stats.matched}</span>}
            {(stats.guardSkipped ?? 0) > 0 && <span>guard-skipped {stats.guardSkipped}</span>}
            {gates.length > 0 && <span>{gates.join(', ')}</span>}
            {life.length > 0 && <span>{life.join(', ')}</span>}
          </div>
          {outcome && (
            <div className={`text-[10px] mt-0.5 truncate ${outcomeBad ? 'text-yellow-400' : 'text-text-tertiary'}`} title={outcome}>
              {outcome}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {l.pending && !l.pausedAt && !l.disabledAt && (
            <button onClick={onFlush} className="text-text-tertiary hover:text-text-primary p-1" title="Fire the pending batch now">
              <Zap size={11} />
            </button>
          )}
          {l.pausedAt || l.disabledAt ? (
            <button onClick={onResume} className="text-text-tertiary hover:text-text-primary p-1" title={l.disabledAt ? 'Re-enable' : 'Resume'}>
              <Play size={11} />
            </button>
          ) : (
            <button onClick={onPause} className="text-text-tertiary hover:text-text-primary p-1" title="Pause">
              <Pause size={11} />
            </button>
          )}
          <button onClick={onRemove} className="text-text-tertiary hover:text-destructive p-1" title="Remove">
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------

function describeAction(a: ListenerAction): string {
  switch (a.type) {
    case 'wake': return `wake${a.fork ? ` (fork${a.model ? ` ${a.model}` : ''})` : ''}${a.as ? ` @${a.as}` : ''}: ${a.prompt}`
    case 'run': return `run: ${a.cmd}`
    case 'post': return `post ${a.method ?? 'POST'} ${a.url}`
    case 'notify': return `notify: ${a.title}`
    case 'emit': return `emit ${a.topic}`
    case 'card': return `card ${a.project}: ${a.text}`
    default: return (a as { type: string }).type
  }
}

function whereText(where: NonNullable<HubListener['where']>): string {
  return where.map((c) => (c.op === 'in' ? `${c.path} in ${c.value}` : `${c.path}${c.op}${c.value}`)).join(' && ')
}

function fmtDur(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}
