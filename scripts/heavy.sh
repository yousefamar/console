#!/usr/bin/env bash
# Serialise disk-heavy steps (tsc, vitest, gradle, npm install) across every
# Console worktree on this machine: all forks share one disk, and a fan-out of
# parallel typechecks stalls every sibling AND the hub's own board writes.
# Usage: scripts/heavy.sh <cmd> [args…]   — blocks until the lock is free.
set -euo pipefail
LOCK="${CONSOLE_HEAVY_LOCK:-/tmp/console-heavy.lock}"
[ $# -gt 0 ] || { echo "usage: scripts/heavy.sh <cmd> [args…]" >&2; exit 2; }
exec flock -w "${CONSOLE_HEAVY_WAIT:-1800}" "$LOCK" "$@"
