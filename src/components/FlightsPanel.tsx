// FlightsPanel — calendar-sidebar (compact) or mobile-sheet (comfortable)
// section for flight watchlists.
//
// Backed by useFlightsStore (which mirrors hub state via the sync bus). Each
// watchlist row shows the latest best price, a colour-coded delta vs the
// previous poll, a refresh button, and a remove button. Click the row to
// expand a results list (destinations for "explore" / candidate flights for
// "route" watchlists).
//
// Two display modes via the `compact` prop:
//   • compact (default) — desktop sidebar; w-52, tiny text.
//   • non-compact      — mobile sheet; full width, readable text + bigger
//     hit targets. No outer collapse toggle (the sheet itself toggles).

import { useEffect, useState } from 'react'
import {
  Plane,
  Plus,
  RefreshCw,
  Trash2,
  ChevronRight,
  ChevronDown,
  TriangleAlert,
} from 'lucide-react'
import {
  useFlightsStore,
  type Watchlist,
  type WatchlistKind,
  type WatchlistResult,
  type RegionKey,
  type TripDuration,
  type CreateWatchlistInput,
} from '@/store/flights'

interface PanelProps {
  /** Compact sidebar styling. False = comfortable mobile-sheet styling. */
  compact?: boolean
}

export function FlightsPanel({ compact = true }: PanelProps) {
  const watchlists = useFlightsStore((s) => s.watchlists)
  const loading = useFlightsStore((s) => s.loading)
  const loaded = useFlightsStore((s) => s.loaded)
  const configured = useFlightsStore((s) => s.configured)
  const expandedId = useFlightsStore((s) => s.expandedId)
  const showAddForm = useFlightsStore((s) => s.showAddForm)
  const runningIds = useFlightsStore((s) => s.runningIds)
  const init = useFlightsStore((s) => s.init)
  const setExpanded = useFlightsStore((s) => s.setExpanded)
  const setShowAddForm = useFlightsStore((s) => s.setShowAddForm)
  const runOne = useFlightsStore((s) => s.runOne)
  const remove = useFlightsStore((s) => s.remove)

  useEffect(() => { void init() }, [init])

  // Sidebar-only collapse. The sheet variant uses the wrapping sheet as the
  // toggle and skips the collapsible header entirely.
  const [collapsed, setCollapsed] = useState(false)
  const showHeader = compact
  const isOpen = !showHeader || !collapsed

  return (
    <div>
      {showHeader && (
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1 px-1 mb-1 w-full text-left group"
        >
          {collapsed
            ? <ChevronRight size={10} className="text-text-tertiary" />
            : <ChevronDown size={10} className="text-text-tertiary" />}
          <Plane size={10} className="text-text-tertiary" />
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary flex-1">
            Flights
          </span>
          {watchlists.length > 0 && (
            <span className="text-[10px] text-text-tertiary">{watchlists.length}</span>
          )}
        </button>
      )}

      {isOpen && (
        <div className={compact ? 'space-y-1' : 'space-y-2'}>
          {configured === false && (
            <div className={`flex items-start gap-1.5 ${compact ? 'px-1 py-1 text-[10px]' : 'p-2 text-xs rounded-sm bg-amber-500/10'} text-amber-500/90`}>
              <TriangleAlert size={compact ? 10 : 14} className="flex-shrink-0 mt-0.5" />
              <span>SerpApi key not set. Run <code className="font-mono">con cal flights credentials --key …</code></span>
            </div>
          )}

          {loaded && watchlists.length === 0 && !showAddForm && (
            <div className={`${compact ? 'px-1 text-[10px]' : 'px-1 py-3 text-sm text-center'} text-text-tertiary italic`}>
              No watchlists yet
            </div>
          )}

          {watchlists.map((wl) => (
            <WatchlistRow
              key={wl.id}
              wl={wl}
              compact={compact}
              expanded={expandedId === wl.id}
              running={runningIds.has(wl.id)}
              onToggle={() => setExpanded(expandedId === wl.id ? null : wl.id)}
              onRun={() => void runOne(wl.id)}
              onRemove={() => void remove(wl.id)}
            />
          ))}

          {showAddForm
            ? <AddForm compact={compact} onCancel={() => setShowAddForm(false)} />
            : <button
                onClick={() => setShowAddForm(true)}
                className={`flex items-center gap-1.5 ${compact ? 'px-1 py-1 text-xs' : 'px-2 py-2 text-sm rounded-sm bg-surface-1 hover:bg-surface-2 w-full justify-center'} text-text-tertiary hover:text-text-secondary transition-colors`}
              >
                <Plus size={compact ? 11 : 14} />
                New watchlist
              </button>}

          {loading && (
            <div className={`${compact ? 'px-1 text-[10px]' : 'px-1 py-2 text-xs'} text-text-tertiary italic`}>
              Loading…
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Single watchlist row + expanded results
// --------------------------------------------------------------------------

function WatchlistRow({ wl, compact, expanded, running, onToggle, onRun, onRemove }: {
  wl: Watchlist
  compact: boolean
  expanded: boolean
  running: boolean
  onToggle: () => void
  onRun: () => void
  onRemove: () => void
}) {
  const price = wl.lastPriceMajor
  const prev = wl.history && wl.history.length >= 2 ? wl.history[wl.history.length - 2]?.priceMajor : undefined
  const delta = price != null && prev != null ? price - prev : undefined
  const underThreshold = price != null && wl.maxPriceMajor != null && price <= wl.maxPriceMajor
  const txtMain = compact ? 'text-xs' : 'text-sm'
  const txtPrice = compact ? 'text-xs' : 'text-base'
  const txtDelta = compact ? 'text-[9px]' : 'text-xs'
  const txtResult = compact ? 'text-[10px]' : 'text-xs'
  const iconSize = compact ? 9 : 14

  return (
    <div className={`group rounded-sm hover:bg-surface-1 transition-colors ${compact ? '' : 'border border-border'}`}>
      <div className={`flex items-center gap-1 ${compact ? 'px-1 py-0.5' : 'px-2 py-2'}`}>
        <button onClick={onToggle} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
          {expanded
            ? <ChevronDown size={iconSize} className="text-text-tertiary flex-shrink-0" />
            : <ChevronRight size={iconSize} className="text-text-tertiary flex-shrink-0" />}
          <span className={`${txtMain} text-text-secondary truncate flex-1`}>
            {wl.label || describe(wl)}
          </span>
          {price != null && (
            <span className={`${txtPrice} font-mono flex-shrink-0 ${underThreshold ? 'text-emerald-500' : 'text-text-primary'}`}>
              {formatPrice(price, wl.currency)}
            </span>
          )}
          {delta != null && delta !== 0 && (
            <span className={`${txtDelta} font-mono flex-shrink-0 ${delta < 0 ? 'text-emerald-500' : 'text-text-tertiary'}`}>
              {delta < 0 ? '↓' : '↑'}{Math.abs(Math.round(delta))}
            </span>
          )}
        </button>
        <button
          onClick={onRun}
          disabled={running}
          title="Poll now"
          className={`${compact ? 'opacity-0 group-hover:opacity-60 hover:!opacity-100' : 'opacity-70 active:opacity-100 p-1'} transition-opacity`}
        >
          <RefreshCw size={iconSize} className={`text-text-tertiary ${running ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={onRemove}
          title="Remove watchlist"
          className={`${compact ? 'opacity-0 group-hover:opacity-60 hover:!opacity-100' : 'opacity-70 active:opacity-100 p-1'} transition-opacity`}
        >
          <Trash2 size={iconSize} className="text-text-tertiary" />
        </button>
      </div>

      {expanded && (
        <div className={`${compact ? 'px-3 pb-1' : 'px-3 pb-3'} space-y-0.5`}>
          {wl.lastError && (
            <div className={`${txtResult} text-red-500/80 italic`}>{wl.lastError}</div>
          )}
          {!wl.lastError && (!wl.lastResults || wl.lastResults.length === 0) && (
            <div className={`${txtResult} text-text-tertiary italic`}>
              No results yet — refresh to poll.
            </div>
          )}
          {wl.lastResults?.slice(0, compact ? 8 : 20).map((r, i) => (
            <ResultRow key={i} r={r} currency={wl.currency} txtClass={txtResult} compact={compact} />
          ))}
          {wl.lastCheckedAt && (
            <div className={`${compact ? 'text-[9px]' : 'text-[10px]'} text-text-tertiary mt-1`}>
              Checked {timeAgo(wl.lastCheckedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Single result row — renders either a route flight (with times, flight #,
// duration, airlines) or an explore destination (window dates, deep link).
// --------------------------------------------------------------------------

function ResultRow({ r, currency, txtClass, compact }: {
  r: WatchlistResult
  currency: string
  txtClass: string
  compact: boolean
}) {
  const dep = clockTime(r.departureTime)
  const arr = clockTime(r.arrivalTime)
  const hasTimes = dep || arr
  const meta: string[] = []
  if (r.flightNumbers && r.flightNumbers.length) meta.push(r.flightNumbers.join(','))
  else if (r.airlines && r.airlines.length) meta.push(r.airlines.join(', '))
  if (r.stops != null) meta.push(r.stops === 0 ? 'direct' : `${r.stops}st`)
  if (r.totalDurationMin) meta.push(formatDuration(r.totalDurationMin))
  const metaLine = meta.join(' · ')

  // Explore: deep link to Google Flights if present
  const linkProps = r.link
    ? { as: 'a' as const, href: r.link, target: '_blank', rel: 'noreferrer' }
    : null

  return (
    <div className={`${compact ? 'py-0.5' : 'py-1'}`}>
      <div className={`flex items-center gap-1 ${txtClass}`}>
        {linkProps
          ? <a {...linkProps} className="text-text-secondary truncate flex-1 hover:underline">{r.label}</a>
          : <span className="text-text-secondary truncate flex-1">{r.label}</span>}
        {hasTimes && (
          <span className="text-text-tertiary font-mono">
            {dep ?? '?'}→{arr ?? '?'}
          </span>
        )}
        {!hasTimes && (r.startDate || r.endDate) && (
          <span className="text-text-tertiary font-mono">
            {compactDate(r.startDate)}{r.endDate ? `–${compactDate(r.endDate)}` : ''}
          </span>
        )}
        <span className="text-text-primary font-mono">
          {formatPrice(r.priceMajor, currency)}
        </span>
      </div>
      {metaLine && (
        <div className={`pl-1 ${compact ? 'text-[9px]' : 'text-[10px]'} text-text-tertiary truncate`}>
          {metaLine}
        </div>
      )}
    </div>
  )
}

function clockTime(s?: string): string | undefined {
  if (!s) return undefined
  // SerpApi format: "YYYY-MM-DD HH:MM" — return the "HH:MM" tail.
  const m = s.match(/(\d{1,2}:\d{2})\s*$/)
  return m ? m[1] : undefined
}

function formatDuration(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}h` : `${h}h${m}m`
}

// --------------------------------------------------------------------------
// Add form
// --------------------------------------------------------------------------

const REGION_OPTIONS: Array<{ value: RegionKey; label: string }> = [
  { value: 'europe', label: 'Europe' },
  { value: 'asia', label: 'Asia' },
  { value: 'northAmerica', label: 'North America' },
  { value: 'southAmerica', label: 'South America' },
  { value: 'africa', label: 'Africa' },
  { value: 'oceania', label: 'Oceania' },
]

const DURATION_OPTIONS: TripDuration[] = ['Weekend', '1 week', '2 weeks']

function AddForm({ compact, onCancel }: { compact: boolean; onCancel: () => void }) {
  const create = useFlightsStore((s) => s.create)
  const [kind, setKind] = useState<WatchlistKind>('explore')
  const [label, setLabel] = useState('')
  const [origin, setOrigin] = useState('LHR')
  const [region, setRegion] = useState<RegionKey>('europe')
  const [destination, setDestination] = useState('')
  const [month, setMonth] = useState('0')
  const [duration, setDuration] = useState<TripDuration>('1 week')
  const [outboundDate, setOutboundDate] = useState('')
  const [returnDate, setReturnDate] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!origin) return
    const input: CreateWatchlistInput = {
      kind,
      origin: origin.trim().toUpperCase(),
      label: label.trim() || undefined,
      maxPriceMajor: maxPrice ? parseFloat(maxPrice) : undefined,
    }
    if (kind === 'explore') {
      input.region = region
      if (destination.trim()) input.destination = destination.trim().toUpperCase()
      input.month = parseInt(month, 10)
      input.duration = duration
    } else {
      if (!destination || !outboundDate) return
      input.destination = destination.trim().toUpperCase()
      input.outboundDate = outboundDate
      if (returnDate) input.returnDate = returnDate
    }
    setSubmitting(true)
    try {
      await create(input)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className={`${compact ? 'px-1 py-1 space-y-1' : 'p-3 space-y-3 border border-border rounded-sm bg-surface-1'} `}
    >
      <div className="flex gap-1">
        <KindToggle compact={compact} value={kind} onChange={setKind} which="explore" label="Anywhere" />
        <KindToggle compact={compact} value={kind} onChange={setKind} which="route" label="Route" />
      </div>

      <Field compact={compact} label="Origin">
        <Input compact={compact} value={origin} onChange={setOrigin} placeholder="LHR" />
      </Field>

      {kind === 'explore' ? (
        <>
          <Field compact={compact} label="Region">
            <Select compact={compact} value={region} onChange={(v) => setRegion(v as RegionKey)}
              options={REGION_OPTIONS.map((r) => ({ value: r.value, label: r.label }))} />
          </Field>
          <Field compact={compact} label="Destination (optional)">
            <Input compact={compact} value={destination} onChange={setDestination} placeholder="e.g. BCN" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field compact={compact} label="Month">
              <Select compact={compact} value={month} onChange={setMonth} options={[
                { value: '0', label: 'Next 6mo' },
                ...Array.from({ length: 12 }, (_, i) => ({
                  value: String(i + 1),
                  label: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][i]!,
                })),
              ]} />
            </Field>
            <Field compact={compact} label="Duration">
              <Select compact={compact} value={duration} onChange={(v) => setDuration(v as TripDuration)}
                options={DURATION_OPTIONS.map((d) => ({ value: d, label: d }))} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field compact={compact} label="Destination">
            <Input compact={compact} value={destination} onChange={setDestination} placeholder="JFK" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field compact={compact} label="Outbound">
              <Input compact={compact} value={outboundDate} onChange={setOutboundDate} type="date" />
            </Field>
            <Field compact={compact} label="Return">
              <Input compact={compact} value={returnDate} onChange={setReturnDate} type="date" />
            </Field>
          </div>
        </>
      )}

      <Field compact={compact} label="Label (optional)">
        <Input compact={compact} value={label} onChange={setLabel} placeholder="Nov Europe" />
      </Field>

      <Field compact={compact} label="Alert under (£)">
        <Input compact={compact} value={maxPrice} onChange={setMaxPrice} placeholder="200" inputMode="decimal" />
      </Field>

      <div className={`flex gap-2 ${compact ? 'pt-1' : 'pt-2'}`}>
        <button
          type="submit"
          disabled={submitting || !origin || (kind === 'route' && (!destination || !outboundDate))}
          className={`flex-1 ${compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-2 text-sm'} bg-accent text-white rounded-sm disabled:opacity-50`}
        >
          {submitting ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`${compact ? 'px-2 py-0.5 text-[10px]' : 'px-4 py-2 text-sm'} text-text-tertiary hover:text-text-secondary`}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function KindToggle({ compact, value, onChange, which, label }: {
  compact: boolean
  value: WatchlistKind
  onChange: (v: WatchlistKind) => void
  which: WatchlistKind
  label: string
}) {
  const active = value === which
  return (
    <button
      type="button"
      onClick={() => onChange(which)}
      className={`flex-1 ${compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-2 text-sm'} rounded-sm transition-colors ${
        active ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {label}
    </button>
  )
}

function Field({ compact, label, children }: { compact: boolean; label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={`block ${compact ? 'text-[9px] mb-0.5' : 'text-xs mb-1'} text-text-tertiary`}>{label}</span>
      {children}
    </label>
  )
}

function Input({ compact, value, onChange, placeholder, type, inputMode }: {
  compact: boolean
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
}) {
  return (
    <input
      type={type ?? 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      inputMode={inputMode}
      className={`w-full ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-2 text-sm'} bg-surface-2 border border-border rounded-sm text-text-primary`}
    />
  )
}

function Select({ compact, value, onChange, options }: {
  compact: boolean
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full ${compact ? 'px-1 py-0.5 text-[10px]' : 'px-2 py-2 text-sm'} bg-surface-2 border border-border rounded-sm text-text-primary`}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function formatPrice(major: number, currency: string): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : ''
  return symbol ? `${symbol}${Math.round(major)}` : `${Math.round(major)} ${currency}`
}

function describe(wl: Watchlist): string {
  if (wl.kind === 'explore') {
    const where = wl.destination || wl.region || 'anywhere'
    const when = wl.month && wl.month > 0
      ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][wl.month - 1]
      : 'next 6mo'
    return `${wl.origin} → ${where} · ${when}`
  }
  return `${wl.origin} → ${wl.destination} · ${wl.outboundDate ?? ''}`
}

function compactDate(iso?: string): string {
  if (!iso) return ''
  // YYYY-MM-DD → DD MMM (e.g. "05 Nov")
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getDate()).padStart(2, '0')} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
