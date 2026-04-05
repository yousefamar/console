// Push notifications — fires browser notifications when app is not focused
// Uses Notification API (not Web Push — hub is always reachable on localhost)

import type { ActivePane } from '@/store/ui'
import { getHubUrl } from '@/hub'

// Track active pane to suppress notifications for the pane user is viewing
let activePane: ActivePane = 'email'

/** Called by UI store when pane changes */
export function setActiveNotificationPane(pane: ActivePane): void {
  activePane = pane
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
export function notify(opts: NotifyOptions): void {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return

  // Always notify if app doesn't have focus (different workspace, minimized, etc.)
  if (document.hasFocus() && opts.data?.pane) {
    // App is focused — only notify if user is on a different pane
    if (activePane === opts.data.pane) return // Same pane, suppress
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
