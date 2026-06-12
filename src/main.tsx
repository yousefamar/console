import './debug-agent' // Must be first — installs console/fetch/error hooks before any app code
import { StrictMode, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { GatedBoot } from './GatedBoot'
import { maybeRunExportSlave } from './migration'
import './index.css'

// Cross-origin migration slave — when iframed by another origin with
// `?migrate=1`, dump IDB+localStorage to the parent and skip the rest of
// boot. Returns true if we're in slave mode.
const isMigrationSlave = maybeRunExportSlave()

if (!isMigrationSlave) {
  // Build identifier — helps detect stale service worker cache. Cheap to
  // log even before the auth gate (it's just a build constant).
  console.log(`[console] built ${__BUILD_TIME__}`)

  // StrictMode toggle: set VITE_STRICT_MODE=false in .env to disable double-renders for profiling
  const Wrapper = import.meta.env.VITE_STRICT_MODE === 'false' ? Fragment : StrictMode

  // GatedBoot:
  // - probes /hub/auth/session FIRST (the only fetch made pre-auth)
  // - while loading, renders an empty <div> — no DOM scaffolding, no panes
  // - if unauthenticated, renders only LoginScreen — still no app DOM
  // - if authenticated, dynamically imports the real app (App, sync-bus,
  //   stores, dayjs plugins, debug, glasses wiring, service worker, …)
  //   and mounts it. Until that point an unauthenticated visitor sees
  //   literally nothing of the SPA structure.
  createRoot(document.getElementById('root')!).render(
    <Wrapper>
      <GatedBoot />
    </Wrapper>,
  )
}
