# Hub health alerting

Nothing that runs unattended on the hub is allowed to fail silently. Two mechanisms, both riding the existing push channel (`pushServer.broadcast` → APK foreground service → Android notification, plus glasses forwarder):

## 1. Sync-loop failure escalation (`server/src/health.ts`)

Every background sync loop reports each tick outcome to the `health` singleton:

| Loop | Where wired | Tick cadence |
|------|-------------|--------------|
| `mail-sync` | `mail/sync.ts` `healthTick()` | 1 min |
| `cal-sync` | `cal/sync.ts` `healthTick()` | 2 min |
| `matrix-sync` | `matrix/sync.ts` `runLoop()` | continuous long-poll |
| `flight-sync` | `flights/sync.ts` `healthTick()` | 24 h |

Behaviour (constants in `HealthMonitor`):
- **3 consecutive failures** → push alert (`id: health:<loop>`, so repeats update one notification). Note the alert latency is `3 × cadence` — minutes for mail, up to 3 days for flights.
- Still failing → **re-alert every 20 further failures**.
- First success after an alert → **recovery push**, counter resets.
- Alerts raised before `index.ts` binds the push sink (early boot) queue and flush on bind.
- A throwing notify sink is caught and logged — the monitor can never take a loop down.

`health.snapshot()` returns per-loop state (consecutive failures, last error, timestamps) for future observability surfaces.

**Adding a new loop**: `import { health } from './health.js'`, call `health.reportSuccess('<name>')` after a good tick and `health.reportFailure('<name>', String(e))` in the catch. Nothing else.

## 2. Cron skip/disable alerts (`server/src/cron/scheduler.ts`)

Agent-cron tasks skip when their target session is gone and used to auto-disable after 10 skips with zero notification. Now:
- **3rd consecutive skip** → warning push naming the task prompt and skip reason.
- **10th skip (auto-disable)** → alert push with the `con cron add` recovery hint.
- Push id `cron:<taskId>` — warning and disable update the same notification.
- Notify sink is optional (tests/headless omit it) and exception-safe.
- **A guard exiting non-zero is NOT a skip** — that's the normal "nothing to do" outcome and deliberately never counts toward the auto-disable budget, so a guarded task that's quiet for months never alerts. Only session-not-found / session-ended go through `recordSkip`.

## Tests

`server/src/__tests__/health.test.ts` (thresholds, re-alert cadence, recovery, isolation, deferred bind, throwing sink) and `server/src/__tests__/cron-alerts.test.ts` (warn-once, disable alert, ended-session reason, counter reset on success, throwing sink). Run with `cd server && npx vitest run`.
