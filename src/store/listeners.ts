// Listeners store — mirrors the hub-side ListenerEngine (server/src/listeners/).
// Same shape as the cron store: polled per session while a session view is
// open, mutations re-fetch. No WebSocket sync.

import { create } from 'zustand'
import { hubFetch } from '@/hub'

export type ListenerAction =
  | { type: 'wake'; prompt: string; as?: string; fork?: boolean; model?: string }
  | { type: 'run'; cmd: string }
  | { type: 'post'; url: string; method?: string }
  | { type: 'notify'; title: string; body?: string }
  | { type: 'emit'; topic: string }
  | { type: 'card'; project: string; text: string; column?: string; assign?: string }

export interface HubListener {
  id: string
  name?: string
  owner: { claudeSessionId: string; agentKey?: string; cwd?: string }
  ownerName?: string
  createdAt: number
  on: string
  where?: Array<{ path: string; op: string; value: string }>
  guard?: string
  coalesceMs?: number
  cooldownMs?: number
  hours?: string
  days?: string
  dropOutside?: boolean
  maxPerHour?: number
  action: ListenerAction
  times?: number
  timesTotal?: number
  expiresAt?: number
  pausedAt?: number
  pauseReason?: string
  disabledAt?: number
  consecutiveSkips?: number
  stats?: { matched?: number; fired?: number; guardSkipped?: number; lastEventAt?: number; lastFiredAt?: number; lastOutcome?: string }
  pending?: { events: string[]; startedAt: number; dueAt: number }
  outcomes?: Array<{ at: number; stage: string; events: string[]; detail?: string }>
}

interface ListenersState {
  bySession: Record<string, HubListener[]>
  errorBySession: Record<string, string | undefined>

  refresh: (claudeSessionId: string) => Promise<void>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  flush: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useListenersStore = create<ListenersState>((set, get) => ({
  bySession: {},
  errorBySession: {},

  refresh: async (claudeSessionId) => {
    try {
      const list = await hubFetch<HubListener[]>(`/listeners?session=${encodeURIComponent(claudeSessionId)}`)
      set((s) => ({
        bySession: { ...s.bySession, [claudeSessionId]: Array.isArray(list) ? list : [] },
        errorBySession: { ...s.errorBySession, [claudeSessionId]: undefined },
      }))
    } catch (e) {
      set((s) => ({ errorBySession: { ...s.errorBySession, [claudeSessionId]: (e as Error).message } }))
    }
  },

  pause: async (id) => {
    await hubFetch(`/listeners/${encodeURIComponent(id)}/pause`, { method: 'POST' })
    await refreshOwnerOf(id, get)
  },

  resume: async (id) => {
    await hubFetch(`/listeners/${encodeURIComponent(id)}/resume`, { method: 'POST' })
    await refreshOwnerOf(id, get)
  },

  flush: async (id) => {
    await hubFetch(`/listeners/${encodeURIComponent(id)}/flush`, { method: 'POST' })
    await refreshOwnerOf(id, get)
  },

  remove: async (id) => {
    const owner = ownerOf(id, get)
    await hubFetch<{ removed: boolean }>(`/listeners/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (owner) await get().refresh(owner)
  },
}))

function ownerOf(id: string, get: () => ListenersState): string | undefined {
  for (const [csid, list] of Object.entries(get().bySession)) {
    if (list.some((l) => l.id === id)) return csid
  }
  return undefined
}

async function refreshOwnerOf(id: string, get: () => ListenersState): Promise<void> {
  const owner = ownerOf(id, get)
  if (owner) await get().refresh(owner)
}
