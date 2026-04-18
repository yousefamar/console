// Push notifications — fires browser notifications when app is not focused
// Uses Notification API (not Web Push — hub is always reachable on localhost)

import type { ActivePane } from '@/store/ui'
import { getHubUrl } from '@/hub'

// Track active pane to suppress notifications for the pane user is viewing
let activePane: ActivePane = 'email'
// Track active agent session to allow notifications for other sessions
let activeAgentSessionId: string | null = null
// Do Not Disturb mode — suppress all notifications
let dndEnabled = false

/** Called by UI store when pane changes */
export function setActiveNotificationPane(pane: ActivePane): void {
  activePane = pane
}

/** Called by agent store when active session changes */
export function setActiveAgentSession(sessionId: string | null): void {
  activeAgentSessionId = sessionId
}

export interface NotifyOptions {
  title: string
  body: string
  icon?: string
  tag?: string
  data?: { pane: ActivePane; itemId?: string }
}

/** Request notification permission. Returns true if granted. */
export async function requestPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

/**
 * Fire a notification based on context:
 * - App not focused (different workspace) → always notify
 * - App focused but on a different pane → notify
 * - App focused and on the same pane → suppress
 */
/** Called by UI store when DND changes */
export function setDoNotDisturb(enabled: boolean): void {
  dndEnabled = enabled
}

export function notify(opts: NotifyOptions): void {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  if (dndEnabled) return

  // Always notify if app doesn't have focus (different workspace, minimized, etc.)
  if (document.hasFocus() && opts.data?.pane) {
    // App is focused on the same pane — suppress unless it's agents pane
    // (agents pane has multiple sessions; only suppress for the active one)
    if (activePane === opts.data.pane) {
      if (opts.data.pane === 'agents' && opts.data.itemId && opts.data.itemId !== activeAgentSessionId) {
        // Viewing agents pane but a different session — allow notification
      } else {
        return // Same pane (and same item for agents), suppress
      }
    }
  }

  // Proxy remote icons through hub so they're same-origin
  // (Brave on Linux only passes same-origin icons to the notification daemon)
  let icon = opts.icon
  if (icon && icon.startsWith('http') && !icon.startsWith(getHubUrl())) {
    icon = `${getHubUrl()}/proxy/icon?url=${encodeURIComponent(icon)}`
  }

  const notification = new Notification(opts.title, {
    body: opts.body,
    icon,
    tag: opts.tag,
    data: opts.data,
    silent: false,
  })

  notification.onclick = () => {
    window.focus()
    notification.close()
    if (opts.data) {
      handleNotificationClick(opts.data)
    }
  }
}

/** Navigate to the correct pane and select the item. */
function handleNotificationClick(data: { pane: ActivePane; itemId?: string }): void {
  // Dynamic imports to avoid circular dependencies
  import('@/store/ui').then(({ useUiStore }) => {
    useUiStore.getState().setActivePane(data.pane)
  })

  if (!data.itemId) return

  switch (data.pane) {
    case 'money':
      import('@/store/money').then(({ useMoneyStore }) => {
        useMoneyStore.getState().selectTransaction(data.itemId!)
      })
      break
    case 'chat':
      import('@/store/chat').then(({ useChatStore }) => {
        useChatStore.getState().selectRoom(data.itemId!)
      })
      break
    case 'email':
      import('@/store/inbox').then(({ useInboxStore }) => {
        useInboxStore.getState().selectThread(data.itemId!)
      })
      break
    case 'agents':
      import('@/store/agent').then(({ useAgentStore }) => {
        useAgentStore.getState().selectSession(data.itemId!)
      })
      break
  }
}

// Listen for service worker notification clicks (when app is backgrounded)
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'notification-click' && event.data.data) {
      handleNotificationClick(event.data.data)
    }
  })
}

// APK push-notification tap → native shell dispatches this event via
// console://pane/<name>?roomId=... deep-link (see MainActivity.handleDeepLink
// and PushService). Route the same way notification.onclick does.
if (typeof window !== 'undefined') {
  window.addEventListener('console:navigate', (event: Event) => {
    const detail = (event as CustomEvent).detail as { pane?: string; itemId?: string } | undefined
    if (!detail?.pane) return
    handleNotificationClick({
      pane: detail.pane as ActivePane,
      itemId: detail.itemId,
    })
  })
}
