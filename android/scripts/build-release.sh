#!/usr/bin/env bash
# Build a signed release APK and publish to the hub's APK directory.
#
# Requires these env vars (set via `~/.config/console/apk-release.env` or exported):
#   CONSOLE_KEYSTORE_PATH      — defaults to ~/.config/console/console-release.jks
#   CONSOLE_KEYSTORE_PASSWORD  — store password
#   CONSOLE_KEY_ALIAS          — defaults to "console"
#   CONSOLE_KEY_PASSWORD       — key password
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-${HOME}/app/Android/Sdk}"

ENV_FILE="${HOME}/.config/console/apk-release.env"
if [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  set -a; . "${ENV_FILE}"; set +a
fi

: "${CONSOLE_KEYSTORE_PASSWORD:?Set CONSOLE_KEYSTORE_PASSWORD (or via ${ENV_FILE})}"
: "${CONSOLE_KEY_PASSWORD:?Set CONSOLE_KEY_PASSWORD (or via ${ENV_FILE})}"
export CONSOLE_KEYSTORE_PATH="${CONSOLE_KEYSTORE_PATH:-${HOME}/.config/console/console-release.jks}"
export CONSOLE_KEY_ALIAS="${CONSOLE_KEY_ALIAS:-console}"

if [ ! -f "${CONSOLE_KEYSTORE_PATH}" ]; then
  echo "Keystore missing: ${CONSOLE_KEYSTORE_PATH}" >&2
  echo "Run android/scripts/generate-keystore.sh first." >&2
  exit 1
fi

cd "${HERE}"
./gradlew assembleRelease

APK_IN="${HERE}/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "${APK_IN}" ]; then
  echo "Release APK not found at ${APK_IN}" >&2
  exit 1
fi

# Extract versionCode / versionName from the built APK via aapt2.
AAPT2="$(find "${ANDROID_HOME}/build-tools" -name aapt2 -print -quit)"
if [ -z "${AAPT2}" ]; then
  echo "aapt2 not found in ${ANDROID_HOME}/build-tools" >&2
  exit 1
fi
V_CODE=$("${AAPT2}" dump badging "${APK_IN}" | sed -n "s/.*versionCode='\\([^']*\\)'.*/\\1/p" | head -1)
V_NAME=$("${AAPT2}" dump badging "${APK_IN}" | sed -n "s/.*versionName='\\([^']*\\)'.*/\\1/p" | head -1)

PUB_DIR="${HOME}/.config/console/apk"
mkdir -p "${PUB_DIR}"
OUT_NAME="console-${V_CODE}.apk"
OUT_PATH="${PUB_DIR}/${OUT_NAME}"
cp "${APK_IN}" "${OUT_PATH}"

SHA=$(sha256sum "${OUT_PATH}" | awk '{print $1}')
cat > "${PUB_DIR}/latest.json" <<EOF
{
  "versionCode": ${V_CODE},
  "versionName": "${V_NAME}",
  "url": "/apk/${OUT_NAME}",
  "sha256": "${SHA}",
  "publishedAt": "$(date -u +%FT%TZ)"
}
EOF

echo
echo "Published:"
echo "  ${OUT_PATH}"
echo "  ${PUB_DIR}/latest.json   (versionCode=${V_CODE} versionName=${V_NAME})"
echo
echo "Hub now serves:"
echo "  https://<hub-host>:9877/apk/latest.json"
echo "  https://<hub-host>:9877/apk/${OUT_NAME}"
