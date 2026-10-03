import { useState, useRef, useEffect, useCallback } from 'react'
import { MapPin } from 'lucide-react'
import {
  autocompletePlaces, fetchPlace, gmapsConfigured, lastKnownLocation, placeLocationText,
  type GSuggestion, type LatLon,
} from '@/utils/gmaps'

interface PlaceAutocompleteProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}

/**
 * A text input with Google Places type-ahead (via the hub). Picking a suggestion
 * resolves it to "Name, address" like Google Calendar does. Without a Maps key
 * on the hub it degrades to a plain input.
 */
export function PlaceAutocomplete({ value, onChange, placeholder, className, autoFocus }: PlaceAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<GSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0)
  const skipQuery = useRef<string | null>(null) // value we just set ourselves — don't re-suggest it
  const biasRef = useRef<LatLon | null | undefined>(undefined)

  // Debounced type-ahead
  useEffect(() => {
    const q = value.trim()
    if (q.length < 2 || q === skipQuery.current) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const t = setTimeout(async () => {
      if (!(await gmapsConfigured())) return
      if (biasRef.current === undefined) biasRef.current = await lastKnownLocation()
      const id = ++reqId.current
      try {
        const res = await autocompletePlaces(q, biasRef.current ?? undefined)
        if (id !== reqId.current) return
        setSuggestions(res)
        setSelectedIndex(0)
        setOpen(res.length > 0)
      } catch {
        if (id === reqId.current) { setSuggestions([]); setOpen(false) }
      }
    }, 250)
    return () => clearTimeout(t)
  }, [value])

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const pick = useCallback(async (s: GSuggestion) => {
    reqId.current++ // drop any in-flight suggestions
    setOpen(false)
    setSuggestions([])
    skipQuery.current = s.text
    onChange(s.text)
    try {
      const text = placeLocationText(await fetchPlace(s.placeId))
      skipQuery.current = text
      onChange(text)
    } catch { /* keep the suggestion text */ }
  }, [onChange])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (suggestions[selectedIndex]) {
        e.preventDefault()
        void pick(suggestions[selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => { skipQuery.current = null; onChange(e.target.value) }}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className={className}
        autoFocus={autoFocus}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div
          ref={listRef}
          className="absolute left-0 top-full mt-1 z-50 w-full max-h-48 overflow-y-auto rounded-sm border border-border bg-surface-1 py-1 shadow-lg animate-fade-in"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.placeId}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); void pick(s) }}
              className={`flex w-full items-start gap-1.5 px-2 py-1.5 text-left text-xs transition-colors duration-fast ${
                i === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-2'
              }`}
            >
              <MapPin size={12} className="text-text-tertiary shrink-0 mt-0.5" />
              <span className="min-w-0">
                <span className="text-text-primary">{s.mainText}</span>
                {s.secondaryText && <span className="text-text-tertiary">{`  ${s.secondaryText}`}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
