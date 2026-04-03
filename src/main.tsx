import { StrictMode, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import dayjs from 'dayjs'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import { App } from './App'
import './index.css'

// Day.js plugins required by @ilamy/calendar
dayjs.extend(isSameOrAfter)
dayjs.extend(isSameOrBefore)
dayjs.extend(timezone)
dayjs.extend(utc)

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
