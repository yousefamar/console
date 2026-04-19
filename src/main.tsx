import './debug-agent' // Must be first — installs console/fetch/error hooks before any app code
import { StrictMode, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import dayjs from 'dayjs'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import { App } from './App'
import { isNative } from './platform'
import { hubBus } from './sync-bus'
import { wireGlassesStore } from './glasses/store'
import { wireG1Events } from './glasses/events'
import './index.css'

// Hub sync bus — a single WebSocket carrying service event streams + RPC.
// Connect eagerly so observers (mail/calendar/matrix) see live events even
// before the first pane renders.
hubBus.connect()

// Day.js plugins required by @ilamy/calendar
dayjs.extend(isSameOrAfter)
dayjs.extend(isSameOrBefore)
dayjs.extend(timezone)
dayjs.extend(utc)

// Build identifier — helps detect stale service worker cache
console.log(`[console] built ${__BUILD_TIME__}`)

// Debug infrastructure (dev only)
if (import.meta.env.DEV) {
  import('./debug')
}

// StrictMode toggle: set VITE_STRICT_MODE=false in .env to disable double-renders for profiling
const Wrapper = import.meta.env.VITE_STRICT_MODE === 'false' ? Fragment : StrictMode

createRoot(document.getElementById('root')!).render(
  <Wrapper>
    <App />
  </Wrapper>,
)

// Register service worker for PWA (production only — SW caching breaks HMR in dev)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js')
}

// In the Android APK, ask for persistent IndexedDB so mail/chat/notes caches
// survive storage pressure. Silent if the browser denies; skipped for regular
// web so users don't see a storage permission prompt they didn't ask for.
if (isNative() && navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {})
}

// Subscribe to native glasses state stream (APK only; no-op in the browser).
wireGlassesStore()
// Subscribe to native 0xF5 event stream (APK only) — touchbar taps,
// long-press, head tilts, dashboard show/hide. Also feeds the in-app
// recent-events debug panel.
wireG1Events()
