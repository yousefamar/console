#!/usr/bin/env bash
# Fast iteration loop — the closest native gets to HMR (~20-40s change→screen).
#
# One-time setup on the phone (Yousef):
#   Settings → Developer options → Wireless debugging → ON
#   → "Pair device with pairing code" → run:  adb pair <ip>:<pair-port>  (enter code)
#   → then the persistent connect port shows on the main Wireless debugging page.
#
# Usage:
#   ./scripts/dev-loop.sh <ip>:<port>       # connect + build + install + launch
#   ./scripts/dev-loop.sh                   # reuse existing adb connection
#   ./scripts/dev-loop.sh --watch           # rebuild+reinstall on source change
#
# Installs the DEBUG variant (io.amar.console.debug) — side-by-side with the
# release app, so the daily driver is never touched. The debug build carries
# the same DebugAgent (screenshots/nav/sql via hub /debug, UA contains
# "-debug" so target it with ?target=debug).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-${HOME}/app/Android/Sdk}"
ADB="${ANDROID_HOME}/platform-tools/adb"

WATCH=0
ADDR=""
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    *) ADDR="$arg" ;;
  esac
done

if [ -n "$ADDR" ]; then
  "$ADB" connect "$ADDR"
fi

if ! "$ADB" devices | awk 'NR>1 && $2=="device"' | grep -q .; then
  echo "No adb device. Pair wireless debugging first (see header)." >&2
  exit 1
fi

build_install() {
  local t0=$SECONDS
  (cd "$HERE" && ./gradlew :app:assembleDebug -q --console=plain)
  "$ADB" install -r -t "$HERE/app/build/outputs/apk/debug/app-debug.apk"
  "$ADB" shell am start -n io.amar.console.debug/io.amar.console.MainActivity
  echo "── on screen in $((SECONDS - t0))s"
}

build_install

if [ "$WATCH" = 1 ]; then
  command -v inotifywait >/dev/null || { echo "install inotify-tools for --watch" >&2; exit 1; }
  echo "watching app/src for changes…"
  while inotifywait -qq -r -e modify,create,delete "$HERE/app/src"; do
    build_install || true
  done
fi
