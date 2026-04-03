import { StrictMode, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

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
