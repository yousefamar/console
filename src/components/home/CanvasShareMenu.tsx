// Share menu for canvas tabs + islands. Opens from the AgentCanvasCard
// header. Lists every tab and island; each row toggles public via
// /dashboard/canvas/{tabs,islands}/<slug>/publish. Published rows show
// the full URL with a Copy button.

import { useEffect, useState, useCallback } from 'react'
import { Share2, X, Copy, Check } from 'lucide-react'
import { hubFetch } from '@/hub'

interface Tab { slug: string; meta: { title?: string; agent?: string } }
interface Island { slug: string; meta: { title?: string; agent?: string } }
interface Publish { kind: 'tab' | 'island'; slug: string; token: string; url: string; createdAt: number }

interface Row {
  kind: 'tab' | 'island'
  slug: string
  title: string
  agent?: string
  publish: Publish | null
}

export function CanvasShareMenu({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // kind:slug
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [tabsRes, islandsRes] = await Promise.all([
        hubFetch<{ tabs: Tab[] }>('/dashboard/canvas/tabs'),
        hubFetch<{ islands: Island[] }>('/dashboard/canvas/islands'),
      ])
      const all: Row[] = []
      for (const t of tabsRes.tabs) {
        const pub = await hubFetch<Publish>(`/dashboard/canvas/tabs/${encodeURIComponent(t.slug)}/publish`)
          .catch(() => null)
        all.push({ kind: 'tab', slug: t.slug, title: t.meta?.title || t.slug, agent: t.meta?.agent, publish: pub })
      }
      for (const i of islandsRes.islands) {
        const pub = await hubFetch<Publish>(`/dashboard/canvas/islands/${encodeURIComponent(i.slug)}/publish`)
          .catch(() => null)
        all.push({ kind: 'island', slug: i.slug, title: i.meta?.title || i.slug, agent: i.meta?.agent, publish: pub })
      }
      setRows(all)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggle = async (row: Row) => {
    const key = `${row.kind}:${row.slug}`
    setBusy(key)
    setError(null)
    try {
      const base = row.kind === 'tab' ? '/dashboard/canvas/tabs' : '/dashboard/canvas/islands'
      const url = `${base}/${encodeURIComponent(row.slug)}/publish`
      if (row.publish) {
        await hubFetch(url, { method: 'DELETE' })
      } else {
        await hubFetch(url, { method: 'POST' })
      }
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const copy = (text: string, rowKey: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(rowKey)
      setTimeout(() => setCopied((c) => c === rowKey ? null : c), 1500)
    }).catch(() => {})
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative z-10 w-full max-w-lg max-h-[70vh] flex flex-col rounded-sm border border-border bg-surface-1 shadow-lg animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
            <Share2 size={13} /> Canvas share
          </h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {rows === null && <p className="text-xs text-text-tertiary">Loading…</p>}
          {rows && rows.length === 0 && <p className="text-xs text-text-tertiary">No tabs or islands yet.</p>}
          {rows?.map((row) => {
            const key = `${row.kind}:${row.slug}`
            return (
              <div key={key} className="border border-border rounded-sm px-3 py-2 bg-surface-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-text-quaternary">{row.kind}</span>
                      <span className="text-sm text-text-primary truncate">{row.title}</span>
                    </div>
                    {row.agent && <span className="text-[10px] text-text-tertiary">by {row.agent}</span>}
                  </div>
                  <button
                    onClick={() => toggle(row)}
                    disabled={busy === key}
                    className={`text-xs px-2 py-1 rounded border transition-colors duration-fast disabled:opacity-50 ${
                      row.publish
                        ? 'text-red-400 border-red-900 hover:bg-red-950'
                        : 'text-text-secondary border-border hover:text-text-primary hover:bg-surface-2'
                    }`}
                  >
                    {busy === key ? '…' : row.publish ? 'Unpublish' : 'Publish'}
                  </button>
                </div>
                {row.publish && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      readOnly
                      value={row.publish.url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 text-[10px] font-mono bg-surface-2 border border-border rounded px-2 py-1 text-text-secondary"
                    />
                    <button
                      onClick={() => copy(row.publish!.url, key)}
                      className="text-text-tertiary hover:text-text-primary transition-colors"
                      title="Copy URL"
                    >
                      {copied === key ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {error && <p className="px-4 py-2 text-[10px] text-destructive border-t border-border">{error}</p>}
        <p className="px-4 py-2 text-[10px] text-text-tertiary border-t border-border">
          Published URLs need no login — anyone with the link can view that single tab/island.
        </p>
      </div>
    </div>
  )
}
