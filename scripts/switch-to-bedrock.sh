#!/usr/bin/env bash
# Switch the whole `claude`-spawning surface (hub agents, Al, ad-hoc CLI) BACK
# to Amazon Bedrock from the first-party Max subscription.
#
# This is now a THIN WRAPPER over `con agent backend set bedrock`. It used to
# hand-roll the two coordinated edits itself (restore settings.json's env from a
# backup + rewrite ~/.config/console/agent-model.json's chain), which meant the
# Bedrock model chain lived in two places — here and BACKEND_PRESETS in
# server/src/auth-backend.ts. They drifted: this script still led with fable-5
# long after opus-5 was verified and promoted, so running it silently DOWNGRADED
# the fleet.
#
# The hub's own switch is strictly better than what this file can do by hand:
#   1. settings.json `env` <- BACKEND_PRESETS.bedrock, with every model alias
#      pointing at an owner-tagged application inference profile ARN (the only
#      route to per-person cost attribution — see server/src/bedrock-profiles.ts).
#      A backup-restore can't know about those.
#   2. the model chain <- that same preset's spawn-verified ids.
#   3. managed env keys absent from the target preset are stripped, so the switch
#      is a clean swap rather than an accumulation of stale keys.
#   4. every live session is FORCE-respawned (a running subprocess already has
#      the old backend's env baked in from its own startup; the in-place
#      set_model fast path cannot fix that).
#
# So: keep the backend definition in ONE place (auth-backend.ts) and let this
# script be just the cron-friendly entry point.
#
# Idempotent: safe to run more than once. Created 2026-07-09 for the Jul-26
# Max-subscription expiry; rewritten 2026-07-31 to stop duplicating the chain.
set -euo pipefail

LOG="$HOME/.config/console/switch-to-bedrock.log"
HUB="https://localhost:9877"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

log "switch-to-bedrock: starting"

# The switch runs inside the hub, so the hub has to be up. It's a pm2 service, so
# this is just "start it if it isn't running" — cheap and idempotent.
if ! curl -skf --max-time 5 "$HUB/health" >/dev/null 2>&1; then
  log "hub not responding — starting it"
  con hub restart >>"$LOG" 2>&1 || pm2 restart console-server --update-env >>"$LOG" 2>&1 || true
  for _ in $(seq 1 30); do
    curl -skf --max-time 2 "$HUB/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -skf --max-time 5 "$HUB/health" >/dev/null 2>&1; then
  log "ERROR: hub still down — cannot switch backend. Investigate: pm2 logs console-server"
  exit 1
fi

# One call: rewrites settings.json's env, swaps the model chain, force-respawns
# every live session. Prints the resulting backend + chain.
log "applying backend switch"
con agent backend set bedrock 2>&1 | tee -a "$LOG"

log "switch-to-bedrock: done — verify with: con agent model get && con agent backend get"
