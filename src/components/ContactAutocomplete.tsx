import { useState, useRef, useEffect, useCallback } from 'react'
import { db } from '@/db'
import { searchContacts } from '@/gmail/api'
import { parseAddressList } from '@/utils/email'

interface Contact {
  name: string
  email: string
  remote?: boolean
  lastSeen?: number // timestamp for recency sort
}

interface ContactAutocompleteProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}

// Cache local contacts so we don't re-query on every keystroke
let contactsCache: Contact[] | null = null
let cacheTime = 0
const CACHE_TTL = 60_000

async function getLocalContacts(): Promise<Contact[]> {
  if (contactsCache && Date.now() - cacheTime < CACHE_TTL) return contactsCache

  const seen = new Map<string, Contact>()

  function upsert(email: string, name: string, date: number) {
    const existing = seen.get(email)
    if (!existing) {
      seen.set(email, { name, email, lastSeen: date })
    } else {
      if (date > (existing.lastSeen ?? 0)) {
        existing.lastSeen = date
        if (name && !existing.name) existing.name = name
      }
    }
  }

  await db.messages.each((msg) => {
    if (msg.fromEmail) {
      upsert(msg.fromEmail, msg.from || '', msg.date)
    }
    if (msg.to) {
      for (const addr of parseAddresses(msg.to)) {
        upsert(addr.email, addr.name, msg.date)
      }
    }
    if (msg.cc) {
      for (const addr of parseAddresses(msg.cc)) {
        upsert(addr.email, addr.name, msg.date)
      }
    }
  })

  contactsCache = [...seen.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  cacheTime = Date.now()
  return contactsCache
}

function parseAddresses(raw: string): Contact[] {
  return parseAddressList(raw).filter((c) => c.email.includes('@'))
}

function filterContacts(contacts: Contact[], query: string): Contact[] {
  const q = query.toLowerCase()
  return contacts.filter(
    (c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q),
  )
}

export function ContactAutocomplete({ value, onChange, placeholder, inputRef: externalRef }: ContactAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<Contact[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const internalRef = useRef<HTMLInputElement>(null)
  const ref = externalRef || internalRef
  const listRef = useRef<HTMLDivElement>(null)
  const remoteReqId = useRef(0)

  const getCurrentToken = useCallback((): string => {
    const parts = value.split(',')
    return (parts[parts.length - 1] || '').trim()
  }, [value])

  const search = useCallback(async (query: string) => {
    if (!query || query.length < 1 || query.includes('>')) {
      setSuggestions([])
      setOpen(false)
      return
    }

    // 1. Show local results immediately
    const local = await getLocalContacts()
    const localMatches = filterContacts(local, query).slice(0, 8)
    setSuggestions(localMatches)
    setSelectedIndex(0)
    setOpen(localMatches.length > 0)

    // 2. Fetch remote results in background (debounced by caller)
    if (query.length < 2) return
    const reqId = ++remoteReqId.current
    try {
      const remote = await searchContacts(query)
      // Bail if a newer search has started
      if (reqId !== remoteReqId.current) return

      // Merge: local first, then remote (deduplicated)
      const localEmails = new Set(localMatches.map((c) => c.email.toLowerCase()))
      const remoteNew = remote
        .filter((c) => !localEmails.has(c.email.toLowerCase()))
        .map((c) => ({ ...c, remote: true }))

      if (remoteNew.length > 0) {
        const merged = [...localMatches, ...remoteNew].slice(0, 10)
        setSuggestions(merged)
        setOpen(true)
      }
    } catch {
      // Remote failed — local results are already showing
    }
  }, [])

  // Debounce search
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  useEffect(() => {
    const token = getCurrentToken()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => search(token), 100)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [value, getCurrentToken, search])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const selectContact = useCallback((contact: Contact) => {
    const parts = value.split(',').map((s) => s.trim()).filter(Boolean)
    parts.pop()
    const formatted = contact.name ? `${contact.name} <${contact.email}>` : contact.email
    parts.push(formatted)
    onChange(parts.join(', ') + ', ')
    setOpen(false)
    setSuggestions([])
  }, [value, onChange])

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
        selectContact(suggestions[selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="relative flex-1">
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        placeholder={placeholder}
      />
      {open && suggestions.length > 0 && (
        <div
          ref={listRef}
          className="absolute left-0 top-full mt-1 z-50 w-80 max-h-48 overflow-y-auto rounded-sm border border-border bg-surface-1 py-1 shadow-lg animate-fade-in"
        >
          {suggestions.map((contact, i) => (
            <button
              key={contact.email}
              onMouseDown={(e) => {
                e.preventDefault()
                selectContact(contact)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-fast ${
                i === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-2'
              }`}
            >
              <span className="text-sm text-text-primary truncate">
                {contact.name || contact.email}
              </span>
              {contact.name && (
                <span className="text-xs text-text-tertiary truncate">
                  {contact.email}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
