import { useState } from 'react'
import { CheckCircle2, XCircle, Trash2, Plus } from 'lucide-react'
import { useDashboardStore, type ProbeResult, type DashboardSnapshot } from '@/store/dashboard'

export function ServersCard() {
  const snapshot = useDashboardStore((s) => s.snapshot)
  const loading = useDashboardStore((s) => s.snapshotLoading)
  const error = useDashboardStore((s) => s.snapshotError)
  const refresh = useDashboardStore((s) => s.refreshSnapshot)
  const addServer = useDashboardStore((s) => s.addServer)
  const removeServer = useDashboardStore((s) => s.removeServer)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !url) return
    await addServer(name, url)
    setName(''); setUrl(''); setAdding(false)
  }

  return (
    <section className="flex flex-col h-full min-h-0 border border-border rounded-sm bg-surface-1 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wide">Servers</h2>
        <div className="flex items-center gap-2">
          {snapshot && (
            <span className="text-[10px] text-text-tertiary">
              {new Date(snapshot.generatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => refresh()}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
            title="Refresh"
          >
            ↻
          </button>
          <button
            onClick={() => setAdding((v) => !v)}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
            title="Add external server"
          >
            <Plus size={11} />
          </button>
        </div>
      </header>

      {adding && (
        <form onSubmit={submit} className="flex flex-col sm:flex-row gap-1 px-3 py-2 border-b border-border bg-surface-0">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name"
            className="sm:flex-1 min-w-0 px-2 py-1 text-xs bg-surface-2 border border-border rounded-sm text-text-primary"
            autoFocus
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="sm:flex-[2] min-w-0 px-2 py-1 text-xs bg-surface-2 border border-border rounded-sm text-text-primary"
          />
          <button type="submit" className="px-2 py-1 text-xs bg-surface-2 hover:bg-surface-1 text-text-primary border border-border rounded-sm">add</button>
        </form>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!snapshot && loading && (
          <div className="px-3 py-4 text-xs text-text-tertiary">Loading…</div>
        )}
        {!snapshot && error && (
          <div className="px-3 py-4 text-xs text-red-400">{error}</div>
        )}
        {snapshot && <SnapshotRows snapshot={snapshot} onRemove={removeServer} />}
      </div>
    </section>
  )
}

function SnapshotRows({ snapshot, onRemove }: { snapshot: DashboardSnapshot; onRemove: (id: string) => void }) {
  return (
    <ul className="divide-y divide-border">
      <Row
        label="hub"
        sublabel={`${snapshot.hub.sessions} session${snapshot.hub.sessions === 1 ? '' : 's'}`}
        ok
        right={fmtUptime(snapshot.hub.uptimeMs)}
      />
      {snapshot.tailscale.map((h, i) => (
        <Row
          key={`ts-${h.dnsName || h.hostname}-${i}`}
          label={h.hostname}
          sublabel={[h.self ? 'self' : 'tailscale', h.os].filter(Boolean).join(' · ')}
          ok={h.online}
          right={h.online ? 'online' : 'offline'}
        />
      ))}
      {snapshot.pm2.map((p) => (
        <Row
          key={`pm2-${p.name}`}
          label={p.name}
          sublabel={`pm2 · ${fmtBytes(p.memoryBytes)} · ${p.restartCount}↻`}
          ok={p.status === 'online'}
          right={p.status === 'online' ? fmtUptime(p.uptimeMs) : p.status}
        />
      ))}
      {snapshot.external.map((e) => (
        <Row
          key={e.id}
          label={e.name}
          sublabel={e.url}
          ok={e.probe.ok}
          right={fmtProbe(e.probe)}
          onRemove={() => onRemove(e.id)}
        />
      ))}
    </ul>
  )
}

function Row({ label, sublabel, ok, right, onRemove }: {
  label: string; sublabel?: string; ok: boolean; right?: string; onRemove?: () => void
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 group">
      {ok ? <CheckCircle2 size={12} className="text-green-500 shrink-0" /> : <XCircle size={12} className="text-red-500 shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary truncate">{label}</div>
        {sublabel && <div className="text-[10px] text-text-tertiary truncate">{sublabel}</div>}
      </div>
      {right && <span className="text-[10px] text-text-tertiary tabular-nums shrink-0">{right}</span>}
      {onRemove && (
        <button
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-red-400 transition-opacity"
          title="Remove"
        >
          <Trash2 size={11} />
        </button>
      )}
    </li>
  )
}

function fmtUptime(ms: number): string {
  if (ms <= 0) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  if (d > 0) return `${d}d`
  const h = Math.floor(s / 3600)
  if (h > 0) return `${h}h`
  const m = Math.floor(s / 60)
  if (m > 0) return `${m}m`
  return `${s}s`
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}K`
  return `${Math.round(b / (1024 * 1024))}M`
}

function fmtProbe(p: ProbeResult): string {
  if (p.ok) return p.latencyMs != null ? `${Math.round(p.latencyMs)}ms` : 'ok'
  return p.error
}
