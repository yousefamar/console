#!/usr/bin/env bash
# Serialise disk-heavy steps (tsc, vitest, gradle, npm install) across every
# Console worktree on this machine: all forks share one disk, and a fan-out of
# parallel typechecks stalls every sibling AND the hub's own board writes.
# Usage: scripts/heavy.sh <cmd> [args…]   — blocks until the lock is free.
# The step also runs at low CPU/IO priority (nice 10, best-effort IO class 7):
# the live voice path (wa-voice, al-voice-pipeline) and the hub must win the
# box — 30 Sept 2026, two calls were unusable at load 16 from forks' tests.
set -euo pipefail
LOCK="${CONSOLE_HEAVY_LOCK:-/tmp/console-heavy.lock}"
[ $# -gt 0 ] || { echo "usage: scripts/heavy.sh <cmd> [args…]" >&2; exit 2; }
exec flock -w "${CONSOLE_HEAVY_WAIT:-1800}" "$LOCK" nice -n "${CONSOLE_HEAVY_NICE:-10}" ionice -c 2 -n 7 "$@"
