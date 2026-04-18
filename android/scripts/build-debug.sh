#!/usr/bin/env bash
# Build a debug APK and print its path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-${HOME}/app/Android/Sdk}"

cd "${HERE}"
./gradlew assembleDebug
APK="${HERE}/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "${APK}" ]; then
  echo
  echo "Debug APK: ${APK}"
  echo "  install with: adb install -r ${APK}"
fi
